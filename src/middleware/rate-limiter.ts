/**
 * ContextZero — Rate Limiting Middleware
 *
 * In-memory token bucket rate limiter with per-route configuration.
 *
 * Features:
 * - O(1) token bucket accounting per client IP
 * - Per-route rate configurations
 * - Retry-After header on 429
 * - Periodic cleanup of idle buckets
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { Logger } from '../logger';

const log = new Logger('rate-limiter');

interface BucketEntry {
    tokens: number;
    lastRefillAt: number;
    lastSeenAt: number;
    ttlMs: number;
}

interface RateConfig {
    maxRequests: number;
    windowMs: number;
}

/** Per-route rate configurations */
const RATE_WINDOW_1_MIN = 60_000;
const RATE_WINDOW_5_MIN = 300_000;

const ROUTE_LIMITS: Record<string, RateConfig> = {
    // Expensive computation endpoints
    '/scg_find_homologs':           { maxRequests: 20,  windowMs: RATE_WINDOW_1_MIN },
    '/scg_blast_radius':            { maxRequests: 30,  windowMs: RATE_WINDOW_1_MIN },
    '/scg_compile_context_capsule': { maxRequests: 30,  windowMs: RATE_WINDOW_1_MIN },
    // Write/mutation endpoints
    '/scg_ingest_repo':             { maxRequests: 5,   windowMs: RATE_WINDOW_5_MIN },
    '/scg_create_change_transaction': { maxRequests: 20, windowMs: RATE_WINDOW_1_MIN },
    '/scg_apply_patch':             { maxRequests: 30,  windowMs: RATE_WINDOW_1_MIN },
    '/scg_validate_change':         { maxRequests: 20,  windowMs: RATE_WINDOW_1_MIN },
    '/scg_commit_change':           { maxRequests: 10,  windowMs: RATE_WINDOW_1_MIN },
    '/scg_rollback_change':         { maxRequests: 10,  windowMs: RATE_WINDOW_1_MIN },
    // Default for all other endpoints
    '__default__':                  { maxRequests: 60,  windowMs: RATE_WINDOW_1_MIN },
};

class TokenBucketLimiter {
    private buckets: Map<string, BucketEntry> = new Map();
    private cleanupInterval: ReturnType<typeof setInterval>;

    constructor() {
        const LIMITER_CLEANUP_INTERVAL_MS = 60_000; // 1 minute
        this.cleanupInterval = setInterval(() => this.cleanup(), LIMITER_CLEANUP_INTERVAL_MS);
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    public check(key: string, config: RateConfig): { allowed: boolean; retryAfterMs: number } {
        const now = Date.now();
        let entry = this.buckets.get(key);

        if (!entry) {
            entry = {
                tokens: config.maxRequests,
                lastRefillAt: now,
                lastSeenAt: now,
                ttlMs: Math.max(config.windowMs * 2, 600_000),
            };
            this.buckets.set(key, entry);
        }

        // Use integer arithmetic to avoid floating-point drift over time.
        // tokensToAdd = floor(elapsedMs * maxRequests / windowMs) avoids
        // compounding rounding errors from repeated float multiplication.
        const elapsedMs = Math.max(0, now - entry.lastRefillAt);
        const tokensToAdd = Math.floor((elapsedMs * config.maxRequests) / config.windowMs);
        entry.tokens = Math.min(config.maxRequests, entry.tokens + tokensToAdd);
        // Only advance lastRefillAt by the time actually consumed to avoid losing partial tokens
        if (tokensToAdd > 0) {
            const msConsumed = Math.floor((tokensToAdd * config.windowMs) / config.maxRequests);
            entry.lastRefillAt += msConsumed;
        }
        entry.lastSeenAt = now;
        entry.ttlMs = Math.max(config.windowMs * 2, 600_000);

        if (entry.tokens < 1) {
            const refillRatePerMs = config.maxRequests / config.windowMs;
            const retryAfterMs = Math.ceil((1 - entry.tokens) / refillRatePerMs);
            return { allowed: false, retryAfterMs };
        }

        entry.tokens -= 1;
        return { allowed: true, retryAfterMs: 0 };
    }

    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.buckets) {
            if ((now - entry.lastSeenAt) > entry.ttlMs) {
                this.buckets.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            log.debug('Rate limiter cleanup', { cleaned, remaining: this.buckets.size });
        }
    }

    public destroy(): void {
        clearInterval(this.cleanupInterval);
        this.buckets.clear();
    }
}

const limiter = new TokenBucketLimiter();

/**
 * Build a composite rate-limit key that is resistant to X-Forwarded-For
 * rotation.  Combines client IP with a hash derived from partial API key
 * and User-Agent so that spoofing only the source address does not grant
 * a fresh token bucket.
 */
function getCompositeKey(req: Request): string {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const headers = req.headers || {};

    // Extract partial API key (first 8 chars) for fingerprinting
    let keyPrefix = 'nokey';
    const authHeader = headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        keyPrefix = authHeader.slice(7, 15);
    } else {
        const xApiKey = headers['x-api-key'];
        if (typeof xApiKey === 'string' && xApiKey.length > 0) {
            keyPrefix = xApiKey.substring(0, 8);
        }
    }

    const ua = (typeof headers['user-agent'] === 'string' ? headers['user-agent'] : 'none').substring(0, 256);
    const fpHash = crypto
        .createHash('sha256')
        .update(`${keyPrefix}:${ua}`)
        .digest('hex')
        .substring(0, 12);

    return `${clientIp}:${fpHash}`;
}

/**
 * Rate limiting middleware.
 * Uses a composite key (IP + partial-key + user-agent hash) + route path
 * as the window key, defeating X-Forwarded-For rotation attacks.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/health' || req.path === '/ready') {
        next();
        return;
    }

    const config = ROUTE_LIMITS[req.path] || ROUTE_LIMITS['__default__']!;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const compositeKey = getCompositeKey(req);
    const key = `${compositeKey}:${req.path}`;

    const result = limiter.check(key, config);

    if (!result.allowed) {
        const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
        log.warn('Rate limit exceeded', { ip: clientIp, path: req.path, retry_after_sec: retryAfterSec });
        res.set('Retry-After', String(retryAfterSec));
        res.status(429).json({
            error: 'Rate limit exceeded',
            retry_after_seconds: retryAfterSec,
            ...(typeof req.correlationId === 'string' && req.correlationId.length > 0
                ? { correlationId: req.correlationId }
                : {}),
        });
        return;
    }

    next();
}

export { limiter };
