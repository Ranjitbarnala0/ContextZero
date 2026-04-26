/**
 * ContextZero — Centralized Configuration
 *
 * Single source of truth for all environment variables and runtime configuration.
 * All modules should import configuration values from this module instead of
 * reading process.env directly.
 *
 * Configuration is loaded and validated once at import time. Invalid or missing
 * required configuration in production causes a hard startup failure with
 * actionable error messages.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ quiet: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function envString(key: string, fallback = ''): string {
    const value = process.env[key];
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function envStringMulti(keys: string[], fallback = ''): string {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === 'string' && value.length > 0) return value;
    }
    return fallback;
}

function envInt(key: string, fallback: number): number {
    const raw = process.env[key];
    if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
    const raw = (process.env[key] || '').trim().toLowerCase();
    if (!raw) return fallback;
    return raw === 'true' || raw === '1' || raw === 'yes';
}

function envList(key: string): string[] {
    return (process.env[key] || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

// ─── Core Environment ────────────────────────────────────────────────────────

export const NODE_ENV = (process.env['NODE_ENV'] || 'development').toLowerCase();
export const isProduction = NODE_ENV === 'production';
export const isDevelopment = NODE_ENV === 'development';
export const isTest = NODE_ENV === 'test';

// ─── Server Configuration ────────────────────────────────────────────────────

export const server = Object.freeze({
    port: envInt('SCG_PORT', 3100),
    host: envString('SCG_HOST', '0.0.0.0'),
    version: envString('SCG_VERSION', '2.0.0'),
    trustProxy: process.env['SCG_TRUST_PROXY'],
    hstsMaxAge: Math.max(0, envInt('SCG_HSTS_MAX_AGE_SECONDS', 31536000)),
    corsOrigins: envList('SCG_CORS_ORIGINS'),
});

// ─── Security Configuration ──────────────────────────────────────────────────

export const security = Object.freeze({
    apiKeys: envList('SCG_API_KEYS'),
    allowedBasePaths: envList('SCG_ALLOWED_BASE_PATHS')
        .filter(p => path.isAbsolute(p)),
    minApiKeyLength: 32,
});

// ─── Database Configuration ──────────────────────────────────────────────────

export const database = Object.freeze({
    host: envStringMulti(['DB_HOST', 'PGHOST'], 'localhost'),
    port: envInt('DB_PORT', 5432),
    name: envStringMulti(['DB_NAME', 'PGDATABASE'], 'scg_v2'),
    user: envStringMulti(['DB_USER', 'PGUSER'], 'postgres'),
    password: envStringMulti(['DB_PASSWORD', 'PGPASSWORD'], ''),
    maxConnections: envInt('DB_MAX_CONNECTIONS', 20),
    statementTimeoutMs: envInt('DB_STATEMENT_TIMEOUT_MS', 30000),
    slowQueryMs: envInt('DB_SLOW_QUERY_MS', 500),
    idleTimeoutMs: envInt('DB_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMs: envInt('DB_CONNECTION_TIMEOUT_MS', 5000),
    sslMode: (() => {
        const mode = envString('DB_SSL_MODE', 'disable');
        const VALID_SSL_MODES = new Set(['disable', 'require', 'verify-ca', 'verify-full']);
        if (VALID_SSL_MODES.has(mode)) return mode as 'disable' | 'require' | 'verify-ca' | 'verify-full';
        process.stderr.write(JSON.stringify({
            timestamp: new Date().toISOString(), level: 'warn', subsystem: 'config',
            message: `Invalid DB_SSL_MODE "${mode}" — falling back to "disable". Valid: disable, require, verify-ca, verify-full`,
        }) + '\n');
        return 'disable' as const;
    })(),
    sslCaPath: envString('DB_SSL_CA'),
    migrationLockTimeoutMs: envInt('DB_MIGRATION_LOCK_TIMEOUT_MS', 10000),
    migrationStatementTimeoutMs: envInt('DB_MIGRATION_STATEMENT_TIMEOUT_MS', 300000),
});

// ─── Logging Configuration ───────────────────────────────────────────────────

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const rawLogLevel = envString('LOG_LEVEL', 'info').toLowerCase();

export const logging = Object.freeze({
    level: VALID_LOG_LEVELS.has(rawLogLevel) ? rawLogLevel as 'debug' | 'info' | 'warn' | 'error' | 'fatal' : 'info',
});

// ─── Runtime Feature Flags ───────────────────────────────────────────────────

export const features = Object.freeze({
    enableMcpAuth: envBool('SCG_MCP_AUTH_ENABLED', false),
    mcpSecret: envString('SCG_MCP_SECRET'),
    mcpAdminSecret: envString('SCG_MCP_ADMIN_SECRET'),
    enableMetrics: envBool('SCG_METRICS_ENABLED', true),
});

// ─── Circuit Breaker Configuration ───────────────────────────────────────────

export const circuitBreaker = Object.freeze({
    failureThreshold: envInt('DB_CIRCUIT_FAILURE_THRESHOLD', 5),
    resetTimeoutMs: envInt('DB_CIRCUIT_RESET_TIMEOUT_MS', 30000),
    halfOpenMaxAttempts: envInt('DB_CIRCUIT_HALF_OPEN_MAX', 3),
});

// ─── Ingestion Configuration ─────────────────────────────────────────────────

export const ingestion = Object.freeze({
    maxFileSizeBytes: envInt('SCG_MAX_FILE_SIZE_BYTES', 1_048_576), // 1MB
    maxFilesPerRepo: envInt('SCG_MAX_FILES_PER_REPO', 100_000),
    workerConcurrency: envInt('SCG_INGEST_WORKERS', 8),
    pythonTimeout: envInt('SCG_PYTHON_TIMEOUT_MS', 30_000),
});

// ─── Retention & Lifecycle Configuration ────────────────────────────────────

export const retention = Object.freeze({
    snapshotMaxAgeDays: envInt('SCG_SNAPSHOT_MAX_AGE_DAYS', 90),
    maxSnapshotsPerRepo: envInt('SCG_MAX_SNAPSHOTS_PER_REPO', 50),
    staleTransactionTimeoutMinutes: envInt('SCG_STALE_TXN_TIMEOUT_MINUTES', 60),
    orphanCleanupEnabled: envBool('SCG_ORPHAN_CLEANUP_ENABLED', true),
    retentionIntervalMinutes: envInt('SCG_RETENTION_INTERVAL_MINUTES', 360), // 6 hours
    retentionEnabled: envBool('SCG_RETENTION_ENABLED', true),
});

// ─── Startup Validation ─────────────────────────────────────────────────────

const startupErrors: string[] = [];

if (isProduction) {
    // API key strength
    if (security.apiKeys.length > 0) {
        const weak = security.apiKeys.filter(k => k.length < security.minApiKeyLength);
        if (weak.length > 0) {
            startupErrors.push(
                `${weak.length} API key(s) are shorter than ${security.minApiKeyLength} characters. ` +
                'Generate strong keys with: openssl rand -hex 32'
            );
        }
    }

    // Allowed base paths
    if (security.allowedBasePaths.length === 0) {
        // Warning only - auth middleware is fail-closed
        process.stderr.write(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'warn',
            subsystem: 'config',
            message: 'SCG_ALLOWED_BASE_PATHS not configured. All repository registrations will be rejected.',
        }) + '\n');
    }
}

/** Call this during application startup to validate all configuration. Throws on fatal errors. */
export function validateConfiguration(): void {
    if (startupErrors.length > 0) {
        throw new Error(
            'Configuration validation failed:\n' +
            startupErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
        );
    }
}

/**
 * Returns a redacted view of the configuration for logging/debugging.
 * Sensitive values (passwords, keys) are replaced with their length indicator.
 */
export function getConfigSummary(): Record<string, unknown> {
    const redact = (s: string) => s ? `[${s.length} chars]` : '[not set]';
    return {
        environment: NODE_ENV,
        server: {
            port: server.port,
            host: server.host,
            version: server.version,
            corsOrigins: server.corsOrigins.length,
        },
        security: {
            apiKeyCount: security.apiKeys.length,
            apiKeyStrength: security.apiKeys.map(k => `${k.length} chars`),
            allowedBasePaths: security.allowedBasePaths,
        },
        database: {
            host: database.host,
            port: database.port,
            name: database.name,
            user: database.user,
            password: redact(database.password),
            sslMode: database.sslMode,
            maxConnections: database.maxConnections,
        },
        logging: { level: logging.level },
        circuitBreaker,
        ingestion,
        retention,
    };
}
