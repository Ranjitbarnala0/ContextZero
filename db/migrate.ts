/**
 * ContextZero — Database Migration Runner
 *
 * Applies versioned SQL migrations in order. Tracks applied migrations
 * in a `_migrations` table to ensure idempotency.
 *
 * Usage:
 *   npx ts-node db/migrate.ts          # Apply all pending migrations
 *   npx ts-node db/migrate.ts --status # Show migration status
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { getConnectionConfig, getMigrationTimeoutConfig } from '../src/db-driver/config';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
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

async function main(): Promise<void> {
    const pool = new Pool(getConnectionConfig());
    const { lockTimeoutMs, statementTimeoutMs } = getMigrationTimeoutConfig();
    const lockClient = await pool.connect();

    try {
        await acquireMigrationLock(lockClient, lockTimeoutMs);

        // Ensure migrations tracking table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) NOT NULL UNIQUE,
                applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                checksum VARCHAR(64) NOT NULL
            )
        `);

        // Get already-applied migrations (with checksums for validation)
        const applied = await pool.query(`SELECT filename, checksum FROM _migrations ORDER BY id`);
        const appliedSet = new Set(applied.rows.map((r: { filename: string }) => r.filename));
        const appliedChecksums = new Map(
            applied.rows.map((r: { filename: string; checksum: string }) => [r.filename, r.checksum]),
        );

        // Discover migration files
        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter(f => f.endsWith('.sql'))
            .sort();

        if (process.argv.includes('--status')) {
            console.log('\n  Migration Status\n  ================\n');
            for (const file of files) {
                const status = appliedSet.has(file) ? '\x1b[32m APPLIED \x1b[0m' : '\x1b[33m PENDING \x1b[0m';
                console.log(`  ${status}  ${file}`);
            }
            console.log(`\n  Total: ${files.length} migrations, ${appliedSet.size} applied\n`);
            return;
        }

        // Validate checksums for already-applied migrations
        const cryptoMod = await import('crypto');
        for (const file of files) {
            if (!appliedSet.has(file)) continue;
            const filePath = path.join(MIGRATIONS_DIR, file);
            const sql = fs.readFileSync(filePath, 'utf-8');
            const currentChecksum = cryptoMod.createHash('sha256').update(sql).digest('hex');
            const storedChecksum = appliedChecksums.get(file);
            if (storedChecksum && storedChecksum !== currentChecksum) {
                if (process.env.NODE_ENV === 'production') {
                    throw new Error(
                        `Checksum mismatch for already-applied migration ${file}: ` +
                        `stored=${storedChecksum}, current=${currentChecksum}. ` +
                        `Refusing to continue — applied migrations must not be modified in production.`,
                    );
                }
                console.warn(
                    `  \x1b[33mWARNING\x1b[0m Checksum mismatch for ${file}:\n` +
                    `    stored:  ${storedChecksum}\n` +
                    `    current: ${currentChecksum}`,
                );
            }
        }

        // Apply pending migrations
        let applied_count = 0;
        for (const file of files) {
            if (appliedSet.has(file)) {
                continue;
            }

            const filePath = path.join(MIGRATIONS_DIR, file);
            const sql = fs.readFileSync(filePath, 'utf-8');
            const checksum = cryptoMod.createHash('sha256').update(sql).digest('hex');

            console.log(`  Applying: ${file}...`);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await applyMigrationTimeouts(client, statementTimeoutMs);
                await client.query(sql);
                await client.query(
                    `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)`,
                    [file, checksum]
                );
                await client.query('COMMIT');
                console.log(`  \x1b[32m✓\x1b[0m ${file} applied successfully`);
                applied_count++;
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  \x1b[31m✗\x1b[0m ${file} FAILED:`, err);
                throw err; // Let outer finally close pool before exiting
            } finally {
                client.release();
            }
        }

        if (applied_count === 0) {
            console.log('  All migrations already applied. Nothing to do.');
        } else {
            console.log(`\n  \x1b[32m${applied_count} migration(s) applied successfully.\x1b[0m\n`);
        }
    } finally {
        try {
            await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
        } finally {
            lockClient.release();
        }
        await pool.end();
    }
}

main().catch(err => {
    console.error('Migration runner failed:', err);
    process.exit(1);
});
