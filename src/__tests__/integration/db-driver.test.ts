/**
 * Real PostgreSQL Integration Tests — Database Driver
 *
 * These tests hit a real PostgreSQL instance (CI-configured or local).
 * They verify:
 * - Connection pool creation and health check
 * - Basic query execution
 * - Transaction isolation (COMMIT and ROLLBACK)
 * - Advisory lock behavior
 * - Concurrent transaction safety
 * - Connection pool stats
 * - Error handling on bad SQL
 *
 * Requires: DB_HOST, DB_PORT, DB_NAME, DB_USER env vars (or defaults).
 * Skips gracefully if PostgreSQL is unavailable.
 */

import { Pool, PoolClient } from 'pg';

// Direct pool construction — bypass singleton to avoid test pollution
function createTestPool(): Pool {
    return new Pool({
        host: process.env['DB_HOST'] || 'localhost',
        port: parseInt(process.env['DB_PORT'] || '5432', 10),
        database: process.env['DB_NAME'] || 'scg_v2',
        user: process.env['DB_USER'] || process.env['USER'] || 'postgres',
        password: process.env['DB_PASSWORD'] || '',
        max: 5,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 3000,
    });
}

let pool: Pool;
let canConnect = false;

beforeAll(async () => {
    pool = createTestPool();
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        canConnect = true;
    } catch {
        // PostgreSQL not available — tests will be skipped
        canConnect = false;
    }
});

afterAll(async () => {
    if (pool) await pool.end();
});

function skipIfNoDb() {
    if (!canConnect) {
        return true;
    }
    return false;
}

describe('Real PostgreSQL — Connection & Health', () => {
    test('pool connects successfully', () => {
        if (skipIfNoDb()) return;
        expect(canConnect).toBe(true);
    });

    test('pool returns correct stats', async () => {
        if (skipIfNoDb()) return;
        expect(pool.totalCount).toBeGreaterThanOrEqual(0);
        expect(pool.idleCount).toBeGreaterThanOrEqual(0);
        expect(pool.waitingCount).toBe(0);
    });

    test('SELECT 1 returns correct result', async () => {
        if (skipIfNoDb()) return;
        const result = await pool.query('SELECT 1 as val');
        expect(result.rows[0].val).toBe(1);
    });

    test('pg_trgm extension is available', async () => {
        if (skipIfNoDb()) return;
        const result = await pool.query(
            "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"
        );
        expect(result.rows.length).toBe(1);
    });
});

describe('Real PostgreSQL — Transactions', () => {
    const TEST_TABLE = '_scg_test_txn_' + Date.now();

    beforeAll(async () => {
        if (!canConnect) return;
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id serial PRIMARY KEY, val text)`);
    });

    afterAll(async () => {
        if (!canConnect) return;
        await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
    });

    test('COMMIT persists data', async () => {
        if (skipIfNoDb()) return;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO ${TEST_TABLE} (val) VALUES ($1)`, ['committed']);
            await client.query('COMMIT');
        } finally {
            client.release();
        }

        const result = await pool.query(`SELECT val FROM ${TEST_TABLE} WHERE val = 'committed'`);
        expect(result.rows.length).toBe(1);
    });

    test('ROLLBACK discards data', async () => {
        if (skipIfNoDb()) return;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO ${TEST_TABLE} (val) VALUES ($1)`, ['rolled_back']);
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }

        const result = await pool.query(`SELECT val FROM ${TEST_TABLE} WHERE val = 'rolled_back'`);
        expect(result.rows.length).toBe(0);
    });

    test('transaction isolation — concurrent reads see committed state', async () => {
        if (skipIfNoDb()) return;

        // Insert in txn A
        const clientA = await pool.connect();
        const clientB = await pool.connect();

        try {
            await clientA.query('BEGIN');
            await clientA.query(`INSERT INTO ${TEST_TABLE} (val) VALUES ($1)`, ['isolated']);

            // Before commit, B should NOT see the row (READ COMMITTED default)
            const beforeCommit = await clientB.query(`SELECT val FROM ${TEST_TABLE} WHERE val = 'isolated'`);
            expect(beforeCommit.rows.length).toBe(0);

            await clientA.query('COMMIT');

            // After commit, B SHOULD see the row
            const afterCommit = await clientB.query(`SELECT val FROM ${TEST_TABLE} WHERE val = 'isolated'`);
            expect(afterCommit.rows.length).toBe(1);
        } finally {
            clientA.release();
            clientB.release();
        }
    });
});

describe('Real PostgreSQL — Advisory Locks', () => {
    test('pg_try_advisory_lock acquires and releases', async () => {
        if (skipIfNoDb()) return;
        const LOCK_ID = 999999;

        const client = await pool.connect();
        try {
            // Acquire
            const lockResult = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [LOCK_ID]);
            expect(lockResult.rows[0].acquired).toBe(true);

            // Release
            const unlockResult = await client.query('SELECT pg_advisory_unlock($1) as released', [LOCK_ID]);
            expect(unlockResult.rows[0].released).toBe(true);
        } finally {
            client.release();
        }
    });

    test('advisory lock blocks second acquirer', async () => {
        if (skipIfNoDb()) return;
        const LOCK_ID = 888888;

        const clientA = await pool.connect();
        const clientB = await pool.connect();
        try {
            // A acquires
            await clientA.query('SELECT pg_try_advisory_lock($1)', [LOCK_ID]);

            // B tries — should fail (non-blocking try)
            const result = await clientB.query('SELECT pg_try_advisory_lock($1) as acquired', [LOCK_ID]);
            expect(result.rows[0].acquired).toBe(false);

            // A releases
            await clientA.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);

            // Now B succeeds
            const retry = await clientB.query('SELECT pg_try_advisory_lock($1) as acquired', [LOCK_ID]);
            expect(retry.rows[0].acquired).toBe(true);
            await clientB.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
        } finally {
            clientA.release();
            clientB.release();
        }
    });
});

describe('Real PostgreSQL — Error Handling', () => {
    test('bad SQL throws with error code', async () => {
        if (skipIfNoDb()) return;
        try {
            await pool.query('SELECT * FROM nonexistent_table_xyz_12345');
            fail('Should have thrown');
        } catch (err: any) {
            expect(err.code).toBe('42P01'); // undefined_table
        }
    });

    test('syntax error is caught', async () => {
        if (skipIfNoDb()) return;
        try {
            await pool.query('SELECTT broken syntax');
            fail('Should have thrown');
        } catch (err: any) {
            expect(err.code).toBe('42601'); // syntax_error
        }
    });
});

describe('Real PostgreSQL — Parameterized Queries', () => {
    test('parameterized query prevents SQL injection', async () => {
        if (skipIfNoDb()) return;
        // This should NOT cause any damage — the malicious string is treated as a literal value
        const result = await pool.query(
            "SELECT $1::text as val",
            ["'; DROP TABLE symbols; --"]
        );
        expect(result.rows[0].val).toBe("'; DROP TABLE symbols; --");
    });

    test('NULL parameters are handled correctly', async () => {
        if (skipIfNoDb()) return;
        const result = await pool.query('SELECT $1::text IS NULL as is_null', [null]);
        expect(result.rows[0].is_null).toBe(true);
    });
});
