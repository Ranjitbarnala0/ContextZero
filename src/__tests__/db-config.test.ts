/**
 * Unit tests for database connection config hardening.
 */

const ORIGINAL_ENV = process.env;

describe('Database config', () => {
    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
        delete process.env['DB_PASSWORD'];
        delete process.env['PGPASSWORD'];
        // Pin to a known-local host so the production SSL check doesn't pick up
        // whatever DB_HOST happens to be set by the ambient .env during tests.
        process.env['DB_HOST'] = 'localhost';
        delete process.env['PGHOST'];
        // Set API keys to empty to prevent the key-entropy check from interfering
        // with DB-config-focused tests. Using empty string (not delete) because
        // dotenv.config() would re-populate from .env if the var is absent.
        process.env['SCG_API_KEYS'] = '';
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    afterEach(() => {
        jest.dontMock('dotenv');
    });

    test('loads dotenv quietly to preserve stdio transports', async () => {
        jest.resetModules();
        const configMock = jest.fn();
        jest.doMock('dotenv', () => ({
            __esModule: true,
            config: configMock,
        }));

        await import('../db-driver/config');

        expect(configMock).toHaveBeenCalledWith({ quiet: true });
    });

    test('allows empty password outside production', async () => {
        const { getConnectionConfig } = await import('../db-driver/config');
        expect(getConnectionConfig().password).toBe('');
    });

    test('rejects missing password in production', async () => {
        process.env['NODE_ENV'] = 'production';
        const { getConnectionConfig } = await import('../db-driver/config');
        expect(() => getConnectionConfig()).toThrow('DB_PASSWORD');
    });

    test('rejects insecure production passwords', async () => {
        process.env['NODE_ENV'] = 'production';
        process.env['DB_PASSWORD'] = 'postgres';
        const { getConnectionConfig } = await import('../db-driver/config');
        expect(() => getConnectionConfig()).toThrow('insecure database password');
    });

    test('accepts explicit secure password in production', async () => {
        process.env['NODE_ENV'] = 'production';
        process.env['DB_PASSWORD'] = 's3cure-prod-password';
        const { getConnectionConfig } = await import('../db-driver/config');
        expect(getConnectionConfig().password).toBe('s3cure-prod-password');
    });
});
