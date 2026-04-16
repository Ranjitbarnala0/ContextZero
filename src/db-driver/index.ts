/**
 * ContextZero — Database Driver
 *
 * PostgreSQL connection pool with:
 * - Circuit breaker (closed → open → half-open) for transient failure resilience
 * - Exponential backoff retry for transient errors
 * - Transaction isolation level support
 * - Query timing, structured logging, and graceful shutdown
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import { Logger } from '../logger';
import { getConnectionConfig } from './config';

const log = new Logger('db-driver');

// ─── Transient Error Detection ───────────────────────────────────────────────

/** PostgreSQL error codes that indicate transient, retryable failures. */
const TRANSIENT_PG_CODES: ReadonlySet<string> = new Set([
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '57P01', // admin_shutdown
    '57P03', // cannot_connect_now
    '40001', // serialization_failure
    '40P01', // deadlock_detected
]);

function isTransientError(error: unknown): boolean {
    if (error == null || typeof error !== 'object') return false;
    const code = (error as { code?: string }).code;
    if (typeof code === 'string' && TRANSIENT_PG_CODES.has(code)) return true;
    const msg = (error as { message?: string }).message || '';
    return msg.includes('Connection terminated') ||
           msg.includes('connection timeout') ||
           msg.includes('ECONNREFUSED') ||
           msg.includes('ECONNRESET');
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

class CircuitBreaker {
    private state: CircuitState = 'closed';
    private consecutiveFailures = 0;
    private lastFailureTime = 0;
    private halfOpenSuccesses = 0;
    private readonly failureThreshold: number;
    private readonly resetTimeoutMs: number;
    private readonly halfOpenMaxSuccesses: number;

    constructor(opts?: {
        failureThreshold?: number;
        resetTimeoutMs?: number;
        halfOpenMaxSuccesses?: number;
    }) {
        const DEFAULT_FAILURE_THRESHOLD = 5;
        const DEFAULT_RESET_TIMEOUT_MS = 30_000;
        const DEFAULT_HALF_OPEN_MAX = 3;
        this.failureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
        this.resetTimeoutMs = opts?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
        this.halfOpenMaxSuccesses = opts?.halfOpenMaxSuccesses ?? DEFAULT_HALF_OPEN_MAX;
    }

    /** Check if a request should be allowed. Throws if the circuit is open. */
    public check(): void {
        if (this.state === 'closed') return;
        if (this.state === 'open') {
            if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
                this.state = 'half-open';
                this.halfOpenSuccesses = 0;
                log.info('Circuit breaker transitioning to half-open', {
                    failureThreshold: this.failureThreshold,
                    resetTimeoutMs: this.resetTimeoutMs,
                });
                return;
            }
            throw new Error(
                'Database circuit breaker is OPEN — fast-failing to prevent cascade. ' +
                `Consecutive failures: ${this.consecutiveFailures}. ` +
                `Will retry in ${Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureTime))}ms.`
            );
        }
        // half-open: allow the request through for probing
    }

    /** Record a successful operation. */
    public recordSuccess(): void {
        if (this.state === 'half-open') {
            this.halfOpenSuccesses++;
            if (this.halfOpenSuccesses >= this.halfOpenMaxSuccesses) {
                this.state = 'closed';
                this.consecutiveFailures = 0;
                log.info('Circuit breaker closed — database connection restored');
            }
        } else if (this.state === 'closed') {
            this.consecutiveFailures = 0;
        }
    }

    /** Record a failed operation. */
    public recordFailure(): void {
        this.consecutiveFailures++;
        this.lastFailureTime = Date.now();
        if (this.state === 'half-open') {
            this.state = 'open';
            log.error('Circuit breaker re-opened — half-open probe failed', undefined, {
                consecutiveFailures: this.consecutiveFailures,
            });
        } else if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
            this.state = 'open';
            log.error('Circuit breaker OPENED — too many consecutive failures', undefined, {
                consecutiveFailures: this.consecutiveFailures,
                resetTimeoutMs: this.resetTimeoutMs,
            });
        }
    }

    public getState(): { state: CircuitState; consecutiveFailures: number } {
        return { state: this.state, consecutiveFailures: this.consecutiveFailures };
    }
}

// ─── Transaction Isolation Levels ────────────────────────────────────────────

export type IsolationLevel = 'read_committed' | 'repeatable_read' | 'serializable';

const ISOLATION_SQL: Record<IsolationLevel, string> = {
    read_committed: 'BEGIN ISOLATION LEVEL READ COMMITTED',
    repeatable_read: 'BEGIN ISOLATION LEVEL REPEATABLE READ',
    serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
};

// ─── Retry Helper ────────────────────────────────────────────────────────────

async function withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries: number; baseDelayMs: number; label: string },
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < opts.maxRetries && isTransientError(error)) {
                const delay = Math.min(opts.baseDelayMs * Math.pow(2, attempt), 10_000);
                log.warn(`Retrying ${opts.label} after transient error (attempt ${attempt + 1}/${opts.maxRetries})`, {
                    error: error instanceof Error ? error.message : String(error),
                    delay_ms: delay,
                });
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    throw lastError;
}

// ─── Database Driver ─────────────────────────────────────────────────────────

class DatabaseDriver {
    private static instance: DatabaseDriver | null = null;
    private pool: Pool;
    private readonly slowQueryMs: number;
    private readonly circuit: CircuitBreaker;
    private readonly maxWaitingQueries: number;
    private lastPoolPressureWarn = 0;
    private closed = false;

    private constructor() {
        const connConfig = getConnectionConfig();
        const safeInt = (raw: string | undefined, fallback: number): number => {
            const parsed = parseInt(raw || String(fallback), 10);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        };
        const maxConnections = safeInt(process.env['DB_MAX_CONNECTIONS'], 20);
        const statementTimeoutMs = safeInt(process.env['DB_STATEMENT_TIMEOUT_MS'], 30_000);
        this.slowQueryMs = safeInt(process.env['DB_SLOW_QUERY_MS'], 500);
        this.maxWaitingQueries = maxConnections * 2; // Reject when queue exceeds 2x pool size
        this.pool = new Pool({
            ...connConfig,
            max: maxConnections,
            idleTimeoutMillis: safeInt(process.env['DB_IDLE_TIMEOUT_MS'], 30_000),
            connectionTimeoutMillis: safeInt(process.env['DB_CONNECTION_TIMEOUT_MS'], 5_000),
            statement_timeout: statementTimeoutMs,
        });

        this.circuit = new CircuitBreaker({
            failureThreshold: safeInt(process.env['DB_CIRCUIT_FAILURE_THRESHOLD'], 5),
            resetTimeoutMs: safeInt(process.env['DB_CIRCUIT_RESET_TIMEOUT_MS'], 30_000),
            halfOpenMaxSuccesses: safeInt(process.env['DB_CIRCUIT_HALF_OPEN_MAX'], 3),
        });

        this.pool.on('error', (err: Error) => {
            log.error('Unexpected error on idle database client', err);
            this.circuit.recordFailure();
        });

        this.pool.on('connect', () => {
            log.debug('New database client connected');
        });

        log.info('Database driver initialized', {
            host: connConfig.host,
            database: connConfig.database,
            max_connections: maxConnections,
            ssl: connConfig.ssl !== false ? 'enabled' : 'disabled',
        });
    }

    public static getInstance(): DatabaseDriver {
        if (!DatabaseDriver.instance) {
            DatabaseDriver.instance = new DatabaseDriver();
        }
        return DatabaseDriver.instance;
    }

    private ensureOpen(): void {
        if (this.closed) {
            throw new Error('Database driver has been closed. Cannot execute queries.');
        }
    }

    public async query(text: string, params?: unknown[]): Promise<QueryResult> {
        this.ensureOpen();
        this.circuit.check();

        // Reject queries when the wait queue is too deep
        if (this.pool.waitingCount > this.maxWaitingQueries) {
            const err = new Error(
                `Database overloaded: ${this.pool.waitingCount} queries waiting ` +
                `(max ${this.maxWaitingQueries}). Rejecting to prevent cascade.`
            );
            log.error('Query rejected — pool queue exceeded', err, {
                waitingCount: this.pool.waitingCount,
                totalCount: this.pool.totalCount,
                idleCount: this.pool.idleCount,
            });
            throw err;
        }

        if (this.pool.waitingCount > 0) {
            const now = Date.now();
            if (now - this.lastPoolPressureWarn >= 5_000) {
                this.lastPoolPressureWarn = now;
                log.warn('Pool pressure: queries waiting for connections', {
                    waitingCount: this.pool.waitingCount,
                    totalCount: this.pool.totalCount,
                    idleCount: this.pool.idleCount,
                });
            }
        }

        return withRetry(
            async () => {
                const start = Date.now();
                try {
                    const result = await this.pool.query(text, params);
                    const duration = Date.now() - start;
                    this.circuit.recordSuccess();
                    if (duration > this.slowQueryMs) {
                        log.warn('Slow query detected', {
                            query: text.substring(0, 200),
                            duration_ms: duration,
                            rows: result.rowCount,
                        });
                    }
                    return result;
                } catch (error) {
                    const duration = Date.now() - start;
                    if (isTransientError(error)) {
                        this.circuit.recordFailure();
                    }
                    log.error('Query execution failed', error, {
                        query: text.substring(0, 200),
                        duration_ms: duration,
                    });
                    throw error;
                }
            },
            { maxRetries: 2, baseDelayMs: 200, label: 'query' },
        );
    }

    public async queryWithClient(client: PoolClient, text: string, params?: unknown[]): Promise<QueryResult> {
        const start = Date.now();
        try {
            const result = await client.query(text, params);
            const duration = Date.now() - start;
            if (duration > this.slowQueryMs) {
                log.warn('Slow query on client', { query: text.substring(0, 200), duration_ms: duration });
            }
            return result;
        } catch (error) {
            log.error('Client query failed', error, { query: text.substring(0, 200) });
            throw error;
        }
    }

    /**
     * Execute a callback within a database transaction.
     * @param callback  The function to run inside the transaction.
     * @param isolation Optional isolation level (defaults to READ COMMITTED).
     */
    public async transaction<T>(
        callback: (client: PoolClient) => Promise<T>,
        isolation?: IsolationLevel,
    ): Promise<T> {
        this.ensureOpen();
        this.circuit.check();

        const client = await this.pool.connect();
        const start = Date.now();
        let rollbackFailed = false;
        try {
            const beginSql = isolation ? ISOLATION_SQL[isolation] : 'BEGIN';
            await client.query(beginSql);
            const result = await callback(client);
            await client.query('COMMIT');
            this.circuit.recordSuccess();
            log.debug('Transaction committed', { duration_ms: Date.now() - start, isolation: isolation || 'read_committed' });
            return result;
        } catch (e) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                rollbackFailed = true;
                log.error('ROLLBACK failed after transaction error', rollbackErr, {
                    original_error: e instanceof Error ? e.message : String(e),
                });
            }
            if (isTransientError(e)) {
                this.circuit.recordFailure();
            }
            log.error('Transaction rolled back', e, { duration_ms: Date.now() - start });
            throw e;
        } finally {
            client.release(rollbackFailed);
        }
    }

    public async batchInsert(statements: { text: string; params: unknown[] }[]): Promise<void> {
        await this.transaction(async (client) => {
            for (const stmt of statements) {
                await client.query(stmt.text, stmt.params);
            }
        });
    }

    public async healthCheck(): Promise<{
        connected: boolean;
        latency_ms: number;
        extensions: { pg_trgm: boolean };
        circuitBreaker: { state: CircuitState; consecutiveFailures: number };
    }> {
        const start = Date.now();
        try {
            await this.pool.query('SELECT 1');

            let pgTrgm = false;
            try {
                const extResult = await this.pool.query(
                    "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'"
                );
                pgTrgm = extResult.rowCount !== null && extResult.rowCount > 0;
            } catch (extErr) {
                log.error('Failed to query pg_extension catalog', extErr);
            }

            if (!pgTrgm) {
                log.warn(
                    'pg_trgm extension is NOT installed — homolog similarity searches will fail. ' +
                    'Install it with: CREATE EXTENSION IF NOT EXISTS pg_trgm;'
                );
            }

            return {
                connected: true,
                latency_ms: Date.now() - start,
                extensions: { pg_trgm: pgTrgm },
                circuitBreaker: this.circuit.getState(),
            };
        } catch (error) {
            log.error('Database health check failed', error);
            return {
                connected: false,
                latency_ms: Date.now() - start,
                extensions: { pg_trgm: false },
                circuitBreaker: this.circuit.getState(),
            };
        }
    }

    public getPoolStats(): { total: number; idle: number; waiting: number } {
        return {
            total: this.pool.totalCount,
            idle: this.pool.idleCount,
            waiting: this.pool.waitingCount,
        };
    }

    public getCircuitState(): { state: CircuitState; consecutiveFailures: number } {
        return this.circuit.getState();
    }

    public async close(): Promise<void> {
        log.info('Closing database connection pool');
        this.closed = true;
        await this.pool.end();
        DatabaseDriver.instance = null;
    }
}

export { CircuitBreaker, isTransientError };
export const db = DatabaseDriver.getInstance();
