/**
 * Programmatic migration runner.
 *
 * Reuses the same logic as db/migrate.ts but runs against the existing
 * connection pool so it can be called from server startup code.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { db } from './index';
import { getConnectionConfig, getMigrationTimeoutConfig } from './config';
import { Logger } from '../logger';

const log = new Logger('migrations');
const MIGRATION_LOCK_KEY = 73297;
const LOCK_POLL_INTERVAL_MS = 250;

async function acquireMigrationLock(client: PoolClient, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = await client.query(
            'SELECT pg_try_advisory_lock($1) AS acquired',
            [MIGRATION_LOCK_KEY],
        );
        if (result.rows[0]?.acquired === true) {
            return;
        }
        await new Promise<void>((resolve) => {
            setTimeout(resolve, LOCK_POLL_INTERVAL_MS);
        });
    }

    throw new Error(`Timed out waiting for the migration advisory lock after ${timeoutMs}ms`);
}

async function applyMigrationTimeouts(client: PoolClient, statementTimeoutMs: number): Promise<void> {
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(statementTimeoutMs)]);
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [String(statementTimeoutMs)]);
    await client.query(`SELECT set_config('idle_in_transaction_session_timeout', $1, true)`, [String(statementTimeoutMs)]);
}

/**
 * Run all pending SQL migrations from the db/migrations directory.
 * Returns the number of migrations applied. Throws on failure.
 *
 * Uses a dedicated connection for the advisory lock to ensure lock/unlock
 * happen on the same session (pg advisory locks are session-scoped).
 */
export async function runPendingMigrations(): Promise<number> {
    // Locate migrations directory — works from both src/ (ts-node) and dist/ (compiled)
    const migrationsDir = path.resolve(__dirname, '../../db/migrations');

    if (!fs.existsSync(migrationsDir)) {
        log.warn('Migrations directory not found, skipping', { path: migrationsDir });
        return 0;
    }

    // Create a dedicated pool connection for the advisory lock.
    // Advisory locks in PostgreSQL are session-scoped — lock and unlock MUST
    // happen on the same connection, which db.query() does NOT guarantee.
    const lockPool = new Pool({
        ...getConnectionConfig(),
        max: 1,
    });
    const lockClient = await lockPool.connect();
    const { lockTimeoutMs, statementTimeoutMs } = getMigrationTimeoutConfig();

    try {

    // Acquire advisory lock to prevent concurrent migration runs
    await acquireMigrationLock(lockClient, lockTimeoutMs);

    // Ensure tracking table exists
    await db.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id SERIAL PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            checksum VARCHAR(64) NOT NULL
        )
    `);

    // Get already-applied migrations (with checksums for validation)
    const applied = await db.query(`SELECT filename, checksum FROM _migrations ORDER BY id`);
    const appliedRows = applied.rows as { filename: string; checksum: string }[];
    const appliedSet = new Set(appliedRows.map(r => r.filename));
    const appliedChecksums = new Map(appliedRows.map(r => [r.filename, r.checksum]));

    // Discover migration files
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    // Validate checksums for already-applied migrations
    for (const file of files) {
        if (!appliedSet.has(file)) continue;
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');
        const currentChecksum = crypto.createHash('sha256').update(sql).digest('hex');
        const storedChecksum = appliedChecksums.get(file);
        if (storedChecksum && storedChecksum !== currentChecksum) {
            if (process.env.NODE_ENV === 'production') {
                throw new Error(
                    `Checksum mismatch for already-applied migration ${file}: ` +
                    `stored=${storedChecksum}, current=${currentChecksum}. ` +
                    `Refusing to continue — applied migrations must not be modified in production.`,
                );
            }
            log.warn(`Checksum mismatch for ${file}`, {
                stored: storedChecksum,
                current: currentChecksum,
            });
        }
    }

    let appliedCount = 0;
    for (const file of files) {
        if (appliedSet.has(file)) continue;

        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');

        log.info(`Applying migration: ${file}`);

        // Run each migration in its own transaction using a dedicated client
        // (db.transaction guarantees BEGIN/sql/COMMIT all run on the same connection)
        await db.transaction(async (client) => {
            await applyMigrationTimeouts(client, statementTimeoutMs);
            await client.query(sql);
            await client.query(
                `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)`,
                [file, checksum],
            );
        });
        log.info(`Migration applied: ${file}`);
        appliedCount++;
    }

    if (appliedCount === 0) {
        log.info('All migrations already applied');
    } else {
        log.info(`${appliedCount} migration(s) applied successfully`);
    }

    return appliedCount;

    } finally {
        // Release advisory lock on the SAME connection that acquired it
        try {
            await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
        } finally {
            lockClient.release();
            await lockPool.end();
        }
    }
}
