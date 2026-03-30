/**
 * Unit tests for src/config.ts — environment-driven configuration.
 *
 * Config is evaluated at import time, so each test uses jest.resetModules()
 * and dynamic import to get a fresh module evaluation with controlled env vars.
 */

const ORIGINAL_ENV = process.env;

beforeEach(() => {
    jest.resetModules();
    // Create a clean copy so we can freely mutate without leaking between tests
    process.env = { ...ORIGINAL_ENV };
    // Prevent dotenv from injecting values from a local .env file
    process.env['SCG_API_KEYS'] = '';
    process.env['SCG_ALLOWED_BASE_PATHS'] = '';
});

afterAll(() => {
    process.env = ORIGINAL_ENV;
});

afterEach(() => {
    jest.dontMock('dotenv');
});

describe('dotenv initialization', () => {
    test('loads configuration quietly to avoid stdout noise', async () => {
        jest.resetModules();
        const configMock = jest.fn();
        jest.doMock('dotenv', () => ({
            __esModule: true,
            config: configMock,
        }));

        await import('../config');

        expect(configMock).toHaveBeenCalledWith({ quiet: true });
    });
});

// ─── Core Environment Flags ──────────────────────────────────────────────────

describe('environment flags', () => {
    test('isProduction is true when NODE_ENV=production', async () => {
        process.env['NODE_ENV'] = 'production';
        // Need strong API keys to prevent startupErrors from being populated
        process.env['SCG_API_KEYS'] = 'a]V8xP2mQ9wK4rL7nB3jF6hT0yU5eC1g';
        process.env['SCG_ALLOWED_BASE_PATHS'] = '/tmp';
        const config = await import('../config');
        expect(config.isProduction).toBe(true);
        expect(config.isDevelopment).toBe(false);
        expect(config.isTest).toBe(false);
    });

    test('isDevelopment is true when NODE_ENV=development', async () => {
        process.env['NODE_ENV'] = 'development';
        const config = await import('../config');
        expect(config.isDevelopment).toBe(true);
        expect(config.isProduction).toBe(false);
        expect(config.isTest).toBe(false);
    });

    test('isTest is true when NODE_ENV=test', async () => {
        process.env['NODE_ENV'] = 'test';
        const config = await import('../config');
        expect(config.isTest).toBe(true);
        expect(config.isProduction).toBe(false);
        expect(config.isDevelopment).toBe(false);
    });

    test('defaults to development when NODE_ENV is not set', async () => {
        delete process.env['NODE_ENV'];
        const config = await import('../config');
        expect(config.NODE_ENV).toBe('development');
        expect(config.isDevelopment).toBe(true);
    });

    test('NODE_ENV is lowercased', async () => {
        process.env['NODE_ENV'] = 'Production';
        process.env['SCG_API_KEYS'] = 'a]V8xP2mQ9wK4rL7nB3jF6hT0yU5eC1g';
        process.env['SCG_ALLOWED_BASE_PATHS'] = '/tmp';
        const config = await import('../config');
        expect(config.NODE_ENV).toBe('production');
        expect(config.isProduction).toBe(true);
    });
});

// ─── Server Configuration ────────────────────────────────────────────────────

describe('server config', () => {
    test('server.port reads from SCG_PORT', async () => {
        process.env['SCG_PORT'] = '4200';
        const config = await import('../config');
        expect(config.server.port).toBe(4200);
    });

    test('server.port defaults to 3100', async () => {
        delete process.env['SCG_PORT'];
        const config = await import('../config');
        expect(config.server.port).toBe(3100);
    });

    test('server.port falls back to default on non-numeric input', async () => {
        process.env['SCG_PORT'] = 'abc';
        const config = await import('../config');
        expect(config.server.port).toBe(3100);
    });

    test('server.host defaults to 0.0.0.0', async () => {
        delete process.env['SCG_HOST'];
        const config = await import('../config');
        expect(config.server.host).toBe('0.0.0.0');
    });

    test('server.host reads from SCG_HOST', async () => {
        process.env['SCG_HOST'] = '127.0.0.1';
        const config = await import('../config');
        expect(config.server.host).toBe('127.0.0.1');
    });

    test('server.version defaults to 2.0.0', async () => {
        delete process.env['SCG_VERSION'];
        const config = await import('../config');
        expect(config.server.version).toBe('2.0.0');
    });
});

// ─── Database Configuration ──────────────────────────────────────────────────

describe('database config', () => {
    test('database.host reads from DB_HOST', async () => {
        process.env['DB_HOST'] = 'mydbhost.example.com';
        const config = await import('../config');
        expect(config.database.host).toBe('mydbhost.example.com');
    });

    test('database.host falls back to PGHOST', async () => {
        // Set DB_HOST to empty so dotenv won't re-inject from .env,
        // and envStringMulti treats empty as "no value" -> checks PGHOST next
        process.env['DB_HOST'] = '';
        process.env['PGHOST'] = 'pg-fallback.local';
        const config = await import('../config');
        expect(config.database.host).toBe('pg-fallback.local');
    });

    test('database.host defaults to localhost', async () => {
        process.env['DB_HOST'] = '';
        process.env['PGHOST'] = '';
        const config = await import('../config');
        expect(config.database.host).toBe('localhost');
    });

    test('DB_HOST takes precedence over PGHOST', async () => {
        process.env['DB_HOST'] = 'primary';
        process.env['PGHOST'] = 'fallback';
        const config = await import('../config');
        expect(config.database.host).toBe('primary');
    });

    test('database.port defaults to 5432', async () => {
        delete process.env['DB_PORT'];
        const config = await import('../config');
        expect(config.database.port).toBe(5432);
    });

    test('database.maxConnections defaults to 20', async () => {
        delete process.env['DB_MAX_CONNECTIONS'];
        const config = await import('../config');
        expect(config.database.maxConnections).toBe(20);
    });
});

// ─── Security Configuration ──────────────────────────────────────────────────

describe('security config', () => {
    test('apiKeys parses comma-separated list', async () => {
        process.env['SCG_API_KEYS'] = 'key-alpha,key-beta,key-gamma';
        const config = await import('../config');
        expect(config.security.apiKeys).toEqual(['key-alpha', 'key-beta', 'key-gamma']);
    });

    test('apiKeys trims whitespace', async () => {
        process.env['SCG_API_KEYS'] = ' key-1 , key-2 ';
        const config = await import('../config');
        expect(config.security.apiKeys).toEqual(['key-1', 'key-2']);
    });

    test('apiKeys returns empty array when not set', async () => {
        process.env['SCG_API_KEYS'] = '';
        const config = await import('../config');
        expect(config.security.apiKeys).toEqual([]);
    });

    test('allowedBasePaths filters non-absolute paths', async () => {
        process.env['SCG_ALLOWED_BASE_PATHS'] = '/valid/path,relative/path,/another/valid';
        const config = await import('../config');
        expect(config.security.allowedBasePaths).toEqual(['/valid/path', '/another/valid']);
        expect(config.security.allowedBasePaths).not.toContain('relative/path');
    });

    test('allowedBasePaths returns empty when all paths are relative', async () => {
        process.env['SCG_ALLOWED_BASE_PATHS'] = 'foo,bar,baz';
        const config = await import('../config');
        expect(config.security.allowedBasePaths).toEqual([]);
    });

    test('minApiKeyLength is 32', async () => {
        const config = await import('../config');
        expect(config.security.minApiKeyLength).toBe(32);
    });
});

// ─── Logging Configuration ───────────────────────────────────────────────────

describe('logging config', () => {
    test('logging.level defaults to info', async () => {
        delete process.env['LOG_LEVEL'];
        const config = await import('../config');
        expect(config.logging.level).toBe('info');
    });

    test('logging.level reads valid level from LOG_LEVEL', async () => {
        process.env['LOG_LEVEL'] = 'debug';
        const config = await import('../config');
        expect(config.logging.level).toBe('debug');
    });

    test('logging.level accepts warn', async () => {
        process.env['LOG_LEVEL'] = 'warn';
        const config = await import('../config');
        expect(config.logging.level).toBe('warn');
    });

    test('logging.level accepts error', async () => {
        process.env['LOG_LEVEL'] = 'error';
        const config = await import('../config');
        expect(config.logging.level).toBe('error');
    });

    test('logging.level accepts fatal', async () => {
        process.env['LOG_LEVEL'] = 'fatal';
        const config = await import('../config');
        expect(config.logging.level).toBe('fatal');
    });

    test('logging.level falls back to info for invalid levels', async () => {
        process.env['LOG_LEVEL'] = 'verbose';
        const config = await import('../config');
        expect(config.logging.level).toBe('info');
    });

    test('logging.level is case-insensitive', async () => {
        process.env['LOG_LEVEL'] = 'DEBUG';
        const config = await import('../config');
        expect(config.logging.level).toBe('debug');
    });
});

// ─── Default Values ──────────────────────────────────────────────────────────

describe('default values', () => {
    test('all defaults are set when no env vars are present', async () => {
        // Set all relevant vars to empty string so dotenv won't re-inject
        // from .env, and envString/envStringMulti treat empty as "no value"
        const keysToClear = [
            'SCG_PORT', 'SCG_HOST', 'SCG_VERSION', 'SCG_TRUST_PROXY',
            'SCG_CORS_ORIGINS', 'SCG_API_KEYS', 'SCG_ALLOWED_BASE_PATHS',
            'DB_HOST', 'PGHOST', 'DB_PORT', 'DB_NAME', 'PGDATABASE',
            'DB_USER', 'PGUSER', 'DB_PASSWORD', 'PGPASSWORD',
            'DB_MAX_CONNECTIONS', 'LOG_LEVEL',
            'SCG_MCP_AUTH_ENABLED', 'SCG_MCP_SECRET',
            'SCG_METRICS_ENABLED',
        ];
        for (const key of keysToClear) {
            process.env[key] = '';
        }
        process.env['NODE_ENV'] = 'test';

        const config = await import('../config');

        expect(config.server.port).toBe(3100);
        expect(config.server.host).toBe('0.0.0.0');
        expect(config.server.version).toBe('2.0.0');
        expect(config.database.host).toBe('localhost');
        expect(config.database.port).toBe(5432);
        expect(config.database.name).toBe('scg_v2');
        expect(config.database.user).toBe('postgres');
        expect(config.database.password).toBe('');
        expect(config.database.maxConnections).toBe(20);
        expect(config.logging.level).toBe('info');
    });
});

// ─── getConfigSummary ────────────────────────────────────────────────────────

describe('getConfigSummary', () => {
    test('redacts database password', async () => {
        process.env['DB_PASSWORD'] = 'super-secret-password';
        const config = await import('../config');
        const summary = config.getConfigSummary();
        const db = summary['database'] as Record<string, unknown>;
        expect(db['password']).toBe('[21 chars]');
        expect(db['password']).not.toBe('super-secret-password');
    });

    test('shows "[not set]" for empty password', async () => {
        delete process.env['DB_PASSWORD'];
        delete process.env['PGPASSWORD'];
        const config = await import('../config');
        const summary = config.getConfigSummary();
        const db = summary['database'] as Record<string, unknown>;
        expect(db['password']).toBe('[not set]');
    });

    test('shows API key strength as char counts', async () => {
        process.env['SCG_API_KEYS'] = 'shortkey,a-longer-key-here';
        const config = await import('../config');
        const summary = config.getConfigSummary();
        const sec = summary['security'] as Record<string, unknown>;
        expect(sec['apiKeyCount']).toBe(2);
        expect(sec['apiKeyStrength']).toEqual(['8 chars', '17 chars']);
    });

    test('includes server, database, logging sections', async () => {
        const config = await import('../config');
        const summary = config.getConfigSummary();
        expect(summary).toHaveProperty('environment');
        expect(summary).toHaveProperty('server');
        expect(summary).toHaveProperty('security');
        expect(summary).toHaveProperty('database');
        expect(summary).toHaveProperty('logging');
        expect(summary).toHaveProperty('circuitBreaker');
        expect(summary).toHaveProperty('ingestion');
    });
});

// ─── validateConfiguration ───────────────────────────────────────────────────

describe('validateConfiguration', () => {
    test('does not throw in development with no API keys', async () => {
        process.env['NODE_ENV'] = 'development';
        const config = await import('../config');
        expect(() => config.validateConfiguration()).not.toThrow();
    });

    test('does not throw in production with strong API keys', async () => {
        process.env['NODE_ENV'] = 'production';
        // 32-char key — meets minApiKeyLength
        process.env['SCG_API_KEYS'] = 'abcdefghijklmnopqrstuvwxyz123456';
        process.env['SCG_ALLOWED_BASE_PATHS'] = '/srv/repos';
        const config = await import('../config');
        expect(() => config.validateConfiguration()).not.toThrow();
    });

    test('throws in production with weak API keys', async () => {
        process.env['NODE_ENV'] = 'production';
        process.env['SCG_API_KEYS'] = 'short-key';
        const config = await import('../config');
        expect(() => config.validateConfiguration()).toThrow(/API key/);
    });

    test('throws in production when some keys are weak', async () => {
        process.env['NODE_ENV'] = 'production';
        // One strong (32 chars), one weak (9 chars)
        process.env['SCG_API_KEYS'] = 'abcdefghijklmnopqrstuvwxyz123456,short-key';
        const config = await import('../config');
        expect(() => config.validateConfiguration()).toThrow(/1 API key/);
    });

    test('does not throw in production with no API keys at all', async () => {
        process.env['NODE_ENV'] = 'production';
        process.env['SCG_API_KEYS'] = '';
        process.env['SCG_ALLOWED_BASE_PATHS'] = '/srv/repos';
        const config = await import('../config');
        // The weak-key check only triggers when apiKeys.length > 0
        expect(() => config.validateConfiguration()).not.toThrow();
    });
});

// ─── Features Configuration ──────────────────────────────────────────────────

describe('features config', () => {
    test('enableMcpAuth defaults to false', async () => {
        delete process.env['SCG_MCP_AUTH_ENABLED'];
        const config = await import('../config');
        expect(config.features.enableMcpAuth).toBe(false);
    });

    test('enableMcpAuth is true when set to "true"', async () => {
        process.env['SCG_MCP_AUTH_ENABLED'] = 'true';
        const config = await import('../config');
        expect(config.features.enableMcpAuth).toBe(true);
    });

    test('enableMetrics defaults to true', async () => {
        delete process.env['SCG_METRICS_ENABLED'];
        const config = await import('../config');
        expect(config.features.enableMetrics).toBe(true);
    });
});
