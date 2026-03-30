/**
 * ContextZero — API Key Authentication Middleware
 *
 * Bearer token and API key authentication. Fail-closed: if no keys
 * configured, all requests are rejected.
 *
 * Supports:
 * - Bearer token in Authorization header
 * - X-API-Key header
 * - Constant-time comparison via crypto.timingSafeEqual
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { Logger } from '../logger';

const log = new Logger('auth');
const PUBLIC_PATHS = new Set(['/health', '/ready']);
const MAX_IP_TRACKING = 10_000;
const INITIAL_LOCKOUT_THRESHOLD = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 60 * 60 * 1000;
const STALE_FAILURE_RETENTION_MS = 30 * 60 * 1000;
const MIN_API_KEY_LENGTH = 32;
const AUTH_SIGHUP_LISTENER_KEY = Symbol.for('scg.auth.sighupListenerRegistered');

/** Load API keys from environment (comma-separated) */
function loadApiKeys(): Buffer[] {
    const raw = process.env['SCG_API_KEYS'] || '';
    if (!raw.trim()) return [];
    return raw.split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0)
        .map(k => Buffer.from(k, 'utf-8'));
}

/**
 * Validate loaded API keys meet minimum length for production use.
 * Logs CRITICAL warnings for each weak key so operators can remediate.
 */
function validateApiKeyEntropy(keys: Buffer[]): void {
    const isProduction = (process.env['NODE_ENV'] || '').toLowerCase() === 'production';
    if (!isProduction || keys.length === 0) {
        return;
    }

    let weakCount = 0;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key !== undefined && key.length < MIN_API_KEY_LENGTH) {
            weakCount++;
            log.warn(
                `CRITICAL: SCG_API_KEYS entry ${i + 1} is ${key.length} chars — ` +
                `minimum ${MIN_API_KEY_LENGTH} required in production. ` +
                `Replace with a cryptographically random value: openssl rand -hex 32`
            );
        }
    }
    if (weakCount > 0) {
        log.warn(
            `CRITICAL: ${weakCount} of ${keys.length} API key(s) do not meet the ` +
            `minimum length of ${MIN_API_KEY_LENGTH} characters. ` +
            `The server will accept them, but they are vulnerable to brute-force attacks.`
        );
    }
}

let apiKeys = loadApiKeys();
validateApiKeyEntropy(apiKeys);

if (apiKeys.length === 0) {
    log.warn('No API keys configured (SCG_API_KEYS). All requests will be rejected.');
}

// ────────── Per-IP Brute-Force Rate Limiting ──────────

interface FailureRecord {
    count: number;
    lockedUntil: number; // epoch ms; 0 = not locked
    lastFailureAt: number; // epoch ms of most recent failure
}

const ipFailures = new Map<string, FailureRecord>();
const fingerprintFailures = new Map<string, FailureRecord>();

/**
 * Build a client fingerprint that is harder to rotate than an IP address.
 * Uses a SHA-256 hash of the full presented API key (not a prefix) combined
 * with a hash of the User-Agent header. An attacker spoofing X-Forwarded-For
 * must ALSO rotate keys and user-agents to evade lockout.
 *
 * Using a hash of the full key instead of an 8-char prefix prevents attackers
 * from generating distinct fingerprints by rotating key prefixes while keeping
 * the same base key pattern.
 */
function getClientFingerprint(req: Request): string {
    const keyHash = (() => {
        const key = extractKey(req);
        return key
            ? crypto.createHash('sha256').update(key).digest('hex').substring(0, 16)
            : 'nokey';
    })();
    const ua = (req.headers['user-agent'] || 'none').substring(0, 256);
    const uaHash = crypto.createHash('sha256').update(ua).digest('hex').substring(0, 12);
    return `fp:${keyHash}:${uaHash}`;
}

/** Exponential lockout after repeated failures, capped to avoid permanent bans. */
function getLockoutMs(failures: number): number {
    if (failures < INITIAL_LOCKOUT_THRESHOLD) return 0;
    const exponent = Math.min(failures - INITIAL_LOCKOUT_THRESHOLD, 7);
    return Math.min(BASE_LOCKOUT_MS * (2 ** exponent), MAX_LOCKOUT_MS);
}

function getRetryAfterMs(ip: string): number {
    const record = ipFailures.get(ip);
    if (!record || record.lockedUntil <= 0) return 0;
    return Math.max(0, record.lockedUntil - Date.now());
}

function getClientIp(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function isPublicPath(pathname: string): boolean {
    return PUBLIC_PATHS.has(pathname);
}

function hotReloadApiKeys(): void {
    const newKeys = loadApiKeys();
    if (newKeys.length === 0) {
        log.warn('SIGHUP: refusing to clear API keys — new set is empty');
        return;
    }
    validateApiKeyEntropy(newKeys);
    apiKeys = newKeys;
    log.info('SIGHUP: API keys reloaded', { count: newKeys.length });
}

export function currentLockoutMsForIp(ip: string): number {
    return getRetryAfterMs(ip);
}

function markAuthFailure(res: Response): void {
    if (!res.locals) {
        (res as Response & { locals: Record<string, unknown> }).locals = {};
    }
    res.locals['authFailure'] = true;
}

/**
 * Check whether a tracking key (IP or fingerprint) is currently throttled
 * within the given failure map.
 */
function isKeyThrottled(map: Map<string, FailureRecord>, key: string): boolean {
    const record = map.get(key);
    if (!record) return false;
    if (record.lockedUntil > 0 && Date.now() < record.lockedUntil) return true;
    // Lock expired — keep the failure count so escalation still works
    return false;
}

/**
 * Check whether a request should be rejected.
 * Checks BOTH the client IP and the client fingerprint — if either
 * is locked out, the request is rejected.  This defeats X-Forwarded-For
 * rotation because the fingerprint stays constant across spoofed IPs.
 */
function isThrottled(ip: string, fingerprint: string): boolean {
    return isKeyThrottled(ipFailures, ip) || isKeyThrottled(fingerprintFailures, fingerprint);
}

/** Record a failure in a given tracking map, with eviction. */
function recordFailureInMap(
    map: Map<string, FailureRecord>,
    key: string,
    label: string,
): void {
    const record = map.get(key) || { count: 0, lockedUntil: 0, lastFailureAt: 0 };
    record.count++;
    record.lastFailureAt = Date.now();
    const lockoutMs = getLockoutMs(record.count);
    if (lockoutMs > 0) {
        record.lockedUntil = Date.now() + lockoutMs;
        log.warn(`${label} locked out due to repeated auth failures`, {
            key, failures: record.count, lockoutMs,
        });
    }
    map.set(key, record);

    // Evict oldest entries when map exceeds size limit (DDoS protection)
    if (map.size > MAX_IP_TRACKING) {
        const now = Date.now();
        let evicted = false;
        for (const [evictKey, evictRecord] of map.entries()) {
            if (evictRecord.lockedUntil < now && evictRecord.count < 5) {
                map.delete(evictKey);
                evicted = true;
                break;
            }
        }
        if (!evicted) {
            const oldestKey = map.keys().next().value;
            if (oldestKey !== undefined) {
                map.delete(oldestKey);
            }
        }
    }
}

function recordFailure(ip: string, fingerprint: string): void {
    recordFailureInMap(ipFailures, ip, 'IP');
    recordFailureInMap(fingerprintFailures, fingerprint, 'Fingerprint');
}

/** Decrement (not full reset) to prevent counter-reset attacks. */
function resetFailuresInMap(map: Map<string, FailureRecord>, key: string): void {
    const record = map.get(key);
    if (record) {
        record.count = Math.max(0, record.count - 1);
        record.lockedUntil = 0;
        if (record.count === 0) {
            map.delete(key);
        }
    }
}

function resetFailures(ip: string, fingerprint: string): void {
    resetFailuresInMap(ipFailures, ip);
    resetFailuresInMap(fingerprintFailures, fingerprint);
}

// Periodic cleanup of stale entries (every 60s)
const AUTH_CLEANUP_INTERVAL_MS = 60_000;
function cleanupFailureMap(map: Map<string, FailureRecord>, now: number): void {
    for (const [key, record] of map.entries()) {
        // Delete if EITHER the entry is stale OR the lock has expired.
        // Using OR prevents unbounded growth under sustained attack where
        // attackers continually refresh lastFailureAt while locked.
        const isStale = record.lastFailureAt < now - STALE_FAILURE_RETENTION_MS;
        const lockExpired = record.lockedUntil > 0 && record.lockedUntil < now;
        const neverLocked = record.lockedUntil === 0;
        if (isStale && (neverLocked || lockExpired)) {
            map.delete(key);
        } else if (lockExpired && isStale) {
            map.delete(key);
        }
    }
    // Hard cap: if map grows beyond MAX_IP_TRACKING, evict oldest entries
    if (map.size > MAX_IP_TRACKING) {
        const entries = [...map.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt);
        const toRemove = map.size - MAX_IP_TRACKING;
        for (let i = 0; i < toRemove; i++) {
            map.delete(entries[i]![0]);
        }
    }
}

const authCleanupTimer = setInterval(() => {
    const now = Date.now();
    cleanupFailureMap(ipFailures, now);
    cleanupFailureMap(fingerprintFailures, now);
}, AUTH_CLEANUP_INTERVAL_MS);
authCleanupTimer.unref();

export function destroyAuthCleanup(): void {
    clearInterval(authCleanupTimer);
    ipFailures.clear();
    fingerprintFailures.clear();
}

/**
 * Constant-time comparison to prevent timing attacks.
 */
function safeCompare(a: Buffer, b: Buffer): boolean {
    // Pad both to the same length to prevent timing oracle on key length.
    // Always compare maxLen bytes so timing is independent of input lengths.
    const maxLen = Math.max(a.length, b.length, 1);
    const paddedA = Buffer.alloc(maxLen, 0);
    const paddedB = Buffer.alloc(maxLen, 0);
    a.copy(paddedA);
    b.copy(paddedB);
    const equal = crypto.timingSafeEqual(paddedA, paddedB);
    // Must also check lengths match — padded comparison alone could match a prefix
    return equal && a.length === b.length;
}

/**
 * Extract API key from request headers.
 * Checks Authorization: Bearer <token> first, then X-API-Key header.
 */
function extractKey(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.length > 0) {
        return xApiKey;
    }
    return null;
}

function isPresentedKeyValid(presented: string): boolean {
    if (apiKeys.length === 0) return false;
    const presentedBuf = Buffer.from(presented, 'utf-8');
    return apiKeys.some(key => safeCompare(presentedBuf, key));
}

function withCorrelationId(
    req: Request,
    body: Record<string, unknown>,
): Record<string, unknown> {
    if (typeof req.correlationId === 'string' && req.correlationId.length > 0) {
        return { ...body, correlationId: req.correlationId };
    }
    return body;
}

export function isRequestAuthenticated(req: Request): boolean {
    const presented = extractKey(req);
    return !!presented && isPresentedKeyValid(presented);
}

/**
 * Authentication middleware.
 * Fail-closed: rejects if no keys configured or no valid key presented.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (isPublicPath(req.path)) {
        next();
        return;
    }

    // Pre-auth brute-force check — reject before any key validation.
    // Check BOTH client IP and fingerprint so that rotating X-Forwarded-For
    // does not grant fresh rate-limit identities.
    const clientIp = getClientIp(req);
    const fingerprint = getClientFingerprint(req);
    if (isThrottled(clientIp, fingerprint)) {
        const ipRetry = getRetryAfterMs(clientIp);
        const fpRecord = fingerprintFailures.get(fingerprint);
        const fpRetry = fpRecord && fpRecord.lockedUntil > 0
            ? Math.max(0, fpRecord.lockedUntil - Date.now())
            : 0;
        const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(ipRetry, fpRetry) / 1000));
        log.warn('Auth rejected: client throttled', {
            path: req.path,
            ip: clientIp,
            fingerprint,
            retry_after_seconds: retryAfterSeconds,
        });
        res.setHeader('Retry-After', String(retryAfterSeconds));
        markAuthFailure(res);
        res.status(429).json(withCorrelationId(req, {
            error: 'Too many authentication failures. Try again later.',
            retry_after_seconds: retryAfterSeconds,
        }));
        return;
    }

    if (apiKeys.length === 0) {
        log.warn('Auth rejected: no API keys configured', { path: req.path });
        res.status(503).json(withCorrelationId(req, {
            error: 'Service not configured — no API keys set',
        }));
        return;
    }

    const presented = extractKey(req);
    if (!presented) {
        recordFailure(clientIp, fingerprint);
        log.warn('Auth rejected: no key presented', { path: req.path, ip: clientIp });
        markAuthFailure(res);
        res.status(401).json(withCorrelationId(req, {
            error: 'Authentication required. Provide Bearer token or X-API-Key header.',
        }));
        return;
    }

    if (!isPresentedKeyValid(presented)) {
        recordFailure(clientIp, fingerprint);
        log.warn('Auth rejected: invalid key', { path: req.path, ip: clientIp });
        markAuthFailure(res);
        res.status(403).json(withCorrelationId(req, { error: 'Invalid API key' }));
        return;
    }

    // Successful auth — reset failure counter for both IP and fingerprint
    resetFailures(clientIp, fingerprint);
    next();
}

// ────────── SIGHUP: Hot-Reload API Keys ──────────

const authGlobal = globalThis as typeof globalThis & {
    [AUTH_SIGHUP_LISTENER_KEY]?: boolean;
};

if (!authGlobal[AUTH_SIGHUP_LISTENER_KEY]) {
    process.on('SIGHUP', () => {
        hotReloadApiKeys();
    });
    authGlobal[AUTH_SIGHUP_LISTENER_KEY] = true;
}
