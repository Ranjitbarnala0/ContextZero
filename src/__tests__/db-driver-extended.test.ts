/**
 * Extended tests for DatabaseDriver — query, transaction, batchInsert,
 * healthCheck, close, retry logic, and pool pressure handling.
 */

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();
const mockRelease = jest.fn();
const mockOn = jest.fn();

const mockPool = {
    query: mockQuery,
    connect: mockConnect,
    end: mockEnd,
    on: mockOn,
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
};

jest.mock('pg', () => ({
    Pool: jest.fn(() => mockPool),
}));

jest.mock('../db-driver/config', () => ({
    getConnectionConfig: jest.fn(() => ({
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'test',
        password: 'test',
        ssl: false,
    })),
}));

import { db, isTransientError } from '../db-driver';

describe('isTransientError', () => {
    it('returns true for connection_exception code', () => {
        expect(isTransientError({ code: '08000' })).toBe(true);
    });

    it('returns true for connection_failure code', () => {
        expect(isTransientError({ code: '08006' })).toBe(true);
    });

    it('returns true for deadlock_detected code', () => {
        expect(isTransientError({ code: '40P01' })).toBe(true);
    });

    it('returns true for serialization_failure code', () => {
        expect(isTransientError({ code: '40001' })).toBe(true);
    });

    it('returns true for admin_shutdown code', () => {
        expect(isTransientError({ code: '57P01' })).toBe(true);
    });

    it('returns true for Connection terminated message', () => {
        expect(isTransientError({ message: 'Connection terminated unexpectedly' })).toBe(true);
    });

    it('returns true for ECONNREFUSED message', () => {
        expect(isTransientError({ message: 'connect ECONNREFUSED 127.0.0.1:5432' })).toBe(true);
    });

    it('returns true for ECONNRESET message', () => {
        expect(isTransientError({ message: 'read ECONNRESET' })).toBe(true);
    });

    it('returns true for connection timeout message', () => {
        expect(isTransientError({ message: 'connection timeout' })).toBe(true);
    });

    it('returns false for non-transient PG code', () => {
        expect(isTransientError({ code: '42P01' })).toBe(false); // undefined_table
    });

    it('returns false for regular error', () => {
        expect(isTransientError(new Error('syntax error'))).toBe(false);
    });

    it('returns false for null', () => {
        expect(isTransientError(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isTransientError(undefined)).toBe(false);
    });

    it('returns false for non-object', () => {
        expect(isTransientError('string error')).toBe(false);
        expect(isTransientError(42)).toBe(false);
    });
});

describe('DatabaseDriver.query', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPool.waitingCount = 0;
    });

    it('executes a simple query', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
        const result = await db.query('SELECT 1');
        expect(result.rows).toEqual([{ id: 1 }]);
        expect(mockQuery).toHaveBeenCalledWith('SELECT 1', undefined);
    });

    it('executes a parameterized query', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ name: 'test' }], rowCount: 1 });
        const result = await db.query('SELECT * FROM users WHERE id = $1', ['user-1']);
        expect(result.rows[0]).toEqual({ name: 'test' });
        expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', ['user-1']);
    });

    it('rejects when pool queue exceeds max', async () => {
        mockPool.waitingCount = 100;
        await expect(db.query('SELECT 1')).rejects.toThrow('Database overloaded');
        mockPool.waitingCount = 0;
    });

    it('retries on transient error', async () => {
        const transientErr = Object.assign(new Error('Connection terminated'), { code: '08006' });
        mockQuery
            .mockRejectedValueOnce(transientErr)
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await db.query('SELECT 1');
        expect(result.rows).toEqual([]);
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('does not retry on non-transient error', async () => {
        const nonTransientErr = Object.assign(new Error('syntax error'), { code: '42601' });
        mockQuery.mockRejectedValueOnce(nonTransientErr);

        await expect(db.query('SELECT 1')).rejects.toThrow('syntax error');
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('gives up after max retries', async () => {
        const transientErr = Object.assign(new Error('ECONNREFUSED'), { code: '08000' });
        mockQuery
            .mockRejectedValueOnce(transientErr)
            .mockRejectedValueOnce(transientErr)
            .mockRejectedValueOnce(transientErr);

        await expect(db.query('SELECT 1')).rejects.toThrow('ECONNREFUSED');
        // 1 initial + 2 retries = 3 total
        expect(mockQuery).toHaveBeenCalledTimes(3);
    });
});

describe('DatabaseDriver.transaction', () => {
    let mockClient: {
        query: jest.Mock;
        release: jest.Mock;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = {
            query: jest.fn(),
            release: jest.fn(),
        };
        mockConnect.mockResolvedValue(mockClient);
        mockPool.waitingCount = 0;
    });

    it('executes callback within BEGIN/COMMIT', async () => {
        mockClient.query.mockResolvedValue({ rows: [] });

        const result = await db.transaction(async (client) => {
            await client.query('INSERT INTO users VALUES ($1)', ['test']);
            return 'done';
        });

        expect(result).toBe('done');
        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
        expect(mockClient.release).toHaveBeenCalledWith(false);
    });

    it('rolls back on error and releases client', async () => {
        mockClient.query.mockImplementation((sql: string) => {
            if (sql === 'INSERT INTO users VALUES ($1)') {
                throw new Error('constraint violation');
            }
            return Promise.resolve({ rows: [] });
        });

        await expect(
            db.transaction(async (client) => {
                await client.query('INSERT INTO users VALUES ($1)', ['dup']);
            })
        ).rejects.toThrow('constraint violation');

        expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
        expect(mockClient.release).toHaveBeenCalledWith(false);
    });

    it('uses custom isolation level', async () => {
        mockClient.query.mockResolvedValue({ rows: [] });

        await db.transaction(async () => 'result', 'serializable');

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL SERIALIZABLE');
    });

    it('uses repeatable_read isolation', async () => {
        mockClient.query.mockResolvedValue({ rows: [] });

        await db.transaction(async () => 'result', 'repeatable_read');

        expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ');
    });

    it('releases client with error flag when rollback fails', async () => {
        mockClient.query.mockImplementation((sql: string) => {
            if (sql === 'ROLLBACK') {
                throw new Error('rollback failed');
            }
            if (sql.startsWith('INSERT')) {
                throw new Error('original error');
            }
            return Promise.resolve({ rows: [] });
        });

        await expect(
            db.transaction(async (client) => {
                await client.query('INSERT INTO test VALUES (1)');
            })
        ).rejects.toThrow('original error');

        expect(mockClient.release).toHaveBeenCalledWith(true);
    });
});

describe('DatabaseDriver.batchInsert', () => {
    let mockClient: {
        query: jest.Mock;
        release: jest.Mock;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        };
        mockConnect.mockResolvedValue(mockClient);
        mockPool.waitingCount = 0;
    });

    it('executes multiple statements in a single transaction', async () => {
        const statements = [
            { text: 'INSERT INTO a VALUES ($1)', params: [1] },
            { text: 'INSERT INTO b VALUES ($1)', params: [2] },
            { text: 'INSERT INTO c VALUES ($1)', params: [3] },
        ];

        await db.batchInsert(statements);

        // BEGIN + 3 inserts + COMMIT = 5 calls
        expect(mockClient.query).toHaveBeenCalledTimes(5);
        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith('INSERT INTO a VALUES ($1)', [1]);
        expect(mockClient.query).toHaveBeenCalledWith('INSERT INTO b VALUES ($1)', [2]);
        expect(mockClient.query).toHaveBeenCalledWith('INSERT INTO c VALUES ($1)', [3]);
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('handles empty batch', async () => {
        await db.batchInsert([]);

        // BEGIN + COMMIT only
        expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
        expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
});

describe('DatabaseDriver.healthCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPool.waitingCount = 0;
    });

    it('returns healthy status when DB is connected', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // SELECT 1
            .mockResolvedValueOnce({ rows: [{ extname: 'pg_trgm' }], rowCount: 1 }); // pg_extension check

        const result = await db.healthCheck();
        expect(result.connected).toBe(true);
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
        expect(result.extensions.pg_trgm).toBe(true);
    });

    it('returns unhealthy status when DB connection fails', async () => {
        mockQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await db.healthCheck();
        expect(result.connected).toBe(false);
        expect(result.extensions.pg_trgm).toBe(false);
    });

    it('returns pg_trgm as false when extension not installed', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // SELECT 1
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no pg_trgm

        const result = await db.healthCheck();
        expect(result.connected).toBe(true);
        expect(result.extensions.pg_trgm).toBe(false);
    });

    it('handles pg_extension query failure gracefully', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // SELECT 1
            .mockRejectedValueOnce(new Error('permission denied')); // pg_extension fails

        const result = await db.healthCheck();
        expect(result.connected).toBe(true);
        expect(result.extensions.pg_trgm).toBe(false);
    });
});

describe('DatabaseDriver.getPoolStats', () => {
    it('returns pool statistics', () => {
        mockPool.totalCount = 10;
        mockPool.idleCount = 7;
        mockPool.waitingCount = 2;

        const stats = db.getPoolStats();
        expect(stats).toEqual({ total: 10, idle: 7, waiting: 2 });
    });
});

describe('DatabaseDriver.getCircuitState', () => {
    it('returns circuit breaker state', () => {
        const state = db.getCircuitState();
        expect(state).toHaveProperty('state');
        expect(state).toHaveProperty('consecutiveFailures');
        expect(['closed', 'open', 'half-open']).toContain(state.state);
    });
});

describe('DatabaseDriver.queryWithClient', () => {
    let mockClient: { query: jest.Mock; release: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = {
            query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 }),
            release: jest.fn(),
        };
    });

    it('executes query on provided client', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await db.queryWithClient(mockClient as any, 'SELECT 1');
        expect(result.rows).toEqual([{ id: 1 }]);
        expect(mockClient.query).toHaveBeenCalledWith('SELECT 1', undefined);
    });

    it('propagates errors from client query', async () => {
        mockClient.query.mockRejectedValueOnce(new Error('client error'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(db.queryWithClient(mockClient as any, 'SELECT 1')).rejects.toThrow('client error');
    });
});
