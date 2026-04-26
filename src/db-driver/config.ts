import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as tls from 'tls';
import { Logger } from '../logger';

const log = new Logger('db-driver');

dotenv.config({ quiet: true });

/**
 * Supported SSL modes, matching PostgreSQL's sslmode semantics:
 *   - 'disable'     — No SSL. Plain-text connection.
 *   - 'require'     — Encrypt the connection but do NOT verify the server certificate.
 *   - 'verify-ca'   — Encrypt and verify the server certificate against a trusted CA.
 *   - 'verify-full' — Like verify-ca, plus verify the server hostname matches the cert CN/SAN.
 */
export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

const VALID_SSL_MODES: ReadonlySet<string> = new Set<SslMode>([
    'disable',
    'require',
    'verify-ca',
    'verify-full',
]);

export interface ConnectionConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    /** SSL/TLS configuration passed directly to the pg Pool. `false` disables SSL. */
    ssl: false | tls.ConnectionOptions;
}

export interface MigrationTimeoutConfig {
    lockTimeoutMs: number;
    statementTimeoutMs: number;
}

const INSECURE_PASSWORDS = new Set([
    'postgres',
    'password',
    'changeme',
    'change_me_before_deploying',
    'change-me-before-deploying',
]);

function readStringEnv(keys: string[], fallback = ''): string {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return fallback;
}

function readIntEnv(keys: string[], fallback: number): number {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value !== 'string' || value.trim().length === 0) continue;
        const parsed = parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return fallback;
}

function isProduction(): boolean {
    return (process.env['NODE_ENV'] || '').toLowerCase() === 'production';
}

const MIN_API_KEY_LENGTH = 32;

function validatePassword(password: string): string {
    if (!isProduction()) {
        return password;
    }

    const normalized = password.trim().toLowerCase();
    if (!normalized) {
        throw new Error('DB_PASSWORD (or PGPASSWORD) must be set in production.');
    }

    if (INSECURE_PASSWORDS.has(normalized)) {
        throw new Error('Refusing to start with an insecure database password in production.');
    }

    return password;
}

/**
 * Validate that all configured API keys meet minimum entropy requirements.
 * Called during startup alongside password validation to catch weak credentials early.
 */
function validateApiKeyStrength(): void {
    if (!isProduction()) {
        return;
    }

    const raw = (process.env['SCG_API_KEYS'] || '').trim();
    if (!raw) {
        return; // Absence of keys is handled by the auth middleware (fail-closed).
    }

    const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
    const weak: number[] = [];
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key !== undefined && key.length < MIN_API_KEY_LENGTH) {
            weak.push(i + 1);
        }
    }

    if (weak.length > 0) {
        throw new Error(
            `Insecure API key configuration: SCG_API_KEYS entries [${weak.join(', ')}] ` +
            `are shorter than ${MIN_API_KEY_LENGTH} characters. ` +
            `Generate strong keys with: openssl rand -hex 32`
        );
    }
}

/** Hosts that are considered local — SSL is not enforced for loopback connections. */
const LOCALHOST_HOSTS: ReadonlySet<string> = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
]);

/**
 * Build the SSL/TLS configuration object based on environment variables.
 *
 * Environment variables consumed:
 *   DB_SSL_MODE  — One of 'disable', 'require', 'verify-ca', 'verify-full'.
 *                  Defaults to 'disable' (with a warning when NODE_ENV=production).
 *   DB_SSL_CA    — Absolute path to a PEM-encoded CA certificate file.
 *                  Required when DB_SSL_MODE is 'verify-ca' or 'verify-full'.
 *
 * In production, when the database host is NOT localhost/127.0.0.1/::1, SSL is
 * enforced — the process will refuse to start with DB_SSL_MODE=disable.
 */
function buildSslConfig(host: string): false | tls.ConnectionOptions {
    const rawMode = (process.env['DB_SSL_MODE'] || '').trim().toLowerCase();
    const mode: SslMode = rawMode && VALID_SSL_MODES.has(rawMode)
        ? rawMode as SslMode
        : 'disable';

    // Warn on unrecognised value so operators can catch typos.
    if (rawMode && !VALID_SSL_MODES.has(rawMode)) {
        log.warn('Unrecognised DB_SSL_MODE — falling back to disable', {
            raw_value: rawMode,
            valid_values: [...VALID_SSL_MODES].join(', '),
        });
    }

    const isRemoteHost = !LOCALHOST_HOSTS.has(host);

    // --- Production safety checks ---------------------------------------------------
    if (isProduction()) {
        if (mode === 'disable' && isRemoteHost) {
            throw new Error(
                'Refusing to connect to a remote database without SSL in production. ' +
                `DB_HOST="${host}" is not localhost. ` +
                'Set DB_SSL_MODE to "require", "verify-ca", or "verify-full".'
            );
        }
        if (mode === 'require' && isRemoteHost) {
            throw new Error(
                'Refusing to connect to a remote database with DB_SSL_MODE="require" in production. ' +
                `DB_HOST="${host}" is not localhost. ` +
                '"require" encrypts traffic but does NOT validate the server certificate, ' +
                'leaving the connection open to active MITM attacks. ' +
                'Set DB_SSL_MODE to "verify-ca" or "verify-full" and provide DB_SSL_CA.'
            );
        }
        if (mode === 'disable') {
            log.warn('DB_SSL_MODE=disable in production — database traffic is unencrypted (localhost only)');
        }
    }

    if (mode === 'disable') {
        return false;
    }

    // --- Build tls.ConnectionOptions ------------------------------------------------
    const sslOpts: tls.ConnectionOptions = {};

    // 'require' mode: encrypt but skip certificate verification.
    if (mode === 'require') {
        sslOpts.rejectUnauthorized = false;
    }

    // 'verify-ca' and 'verify-full' need a trusted CA certificate.
    if (mode === 'verify-ca' || mode === 'verify-full') {
        const caPath = (process.env['DB_SSL_CA'] || '').trim();
        if (!caPath) {
            throw new Error(
                `DB_SSL_MODE="${mode}" requires DB_SSL_CA to be set to the path ` +
                'of a PEM-encoded CA certificate file.'
            );
        }

        if (!fs.existsSync(caPath)) {
            throw new Error(
                `CA certificate file not found: "${caPath}". ` +
                'Ensure DB_SSL_CA points to an existing PEM file.'
            );
        }

        sslOpts.ca = fs.readFileSync(caPath, 'utf-8');
        sslOpts.rejectUnauthorized = true;
    }

    // 'verify-full' additionally checks that the server hostname matches the cert.
    if (mode === 'verify-full') {
        sslOpts.servername = host;
        sslOpts.checkServerIdentity = tls.checkServerIdentity;
    }

    return sslOpts;
}

export function getConnectionConfig(): ConnectionConfig {
    const password = validatePassword(readStringEnv(['DB_PASSWORD', 'PGPASSWORD'], ''));
    validateApiKeyStrength();

    const host = readStringEnv(['DB_HOST', 'PGHOST'], 'localhost');
    const ssl = buildSslConfig(host);

    return {
        host,
        port: readIntEnv(['DB_PORT', 'PGPORT'], 5432),
        database: readStringEnv(['DB_NAME', 'PGDATABASE'], 'scg_v2'),
        user: readStringEnv(['DB_USER', 'PGUSER'], 'postgres'),
        password,
        ssl,
    };
}

export function getMigrationTimeoutConfig(): MigrationTimeoutConfig {
    return {
        lockTimeoutMs: readIntEnv(['DB_MIGRATION_LOCK_TIMEOUT_MS'], 10_000),
        statementTimeoutMs: readIntEnv(['DB_MIGRATION_STATEMENT_TIMEOUT_MS'], 300_000),
    };
}
