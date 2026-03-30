/**
 * ContextZero — Retention & Lifecycle Service
 *
 * Manages data lifecycle in production:
 * - Snapshot expiry based on age and per-repo cap
 * - Stale transaction cleanup (stuck in intermediate states)
 * - Orphaned data cleanup (rows referencing deleted parents)
 * - Audit logging of all cleanup operations
 *
 * All operations use advisory locks to prevent concurrent cleanup runs.
 * Deletions cascade via FK constraints — only top-level rows need explicit removal.
 */

import { db } from '../db-driver';
import { Logger } from '../logger';
import { retention } from '../config';

const log = new Logger('retention-service');

// Advisory lock ID for retention operations (chosen to avoid collision with ingestion locks)
const RETENTION_LOCK_ID = 999999937; // prime, avoids collision with ingestion locks

// ────────── Result Types ──────────

export interface RetentionRunResult {
    snapshotsExpired: number;
    snapshotsCapped: number;
    staleTransactionsCleaned: number;
    orphansCleaned: number;
    durationMs: number;
    errors: string[];
}

export interface RetentionStats {
    totalSnapshots: number;
    expiredSnapshots: number;
    staleTransactions: number;
    oldestSnapshotAge: string | null;
    lastCleanupAt: string | null;
    lastCleanupResult: Record<string, unknown> | null;
}

export interface StaleTransactionInfo {
    txn_id: string;
    state: string;
    updated_at: string;
    age_minutes: number;
}

// ────────── Internal Helpers ──────────

async function logCleanup(
    operation: string,
    targetTable: string,
    rowsAffected: number,
    details?: Record<string, unknown>,
): Promise<void> {
    await db.query(
        `INSERT INTO cleanup_log (operation, target_table, rows_affected, details)
         VALUES ($1, $2, $3, $4)`,
        [operation, targetTable, rowsAffected, details ? JSON.stringify(details) : null],
    );
}

// ────────── Service Functions ──────────

/**
 * Clean up snapshots older than the configured retention window.
 * FK CASCADE handles all dependent rows (files, symbol_versions, profiles, etc.).
 */
export async function cleanupExpiredSnapshots(): Promise<number> {
    const maxAgeDays = retention.snapshotMaxAgeDays;
    if (maxAgeDays <= 0) return 0;

    const timer = log.startTimer('cleanupExpiredSnapshots');

    // First, stamp retained_until on snapshots that don't have one yet
    await db.query(`
        UPDATE snapshots
        SET retained_until = created_at + INTERVAL '1 day' * $1
        WHERE retained_until IS NULL
    `, [maxAgeDays]);

    // Delete snapshots past their retention window, excluding the latest per repo
    const result = await db.query(`
        DELETE FROM snapshots
        WHERE retained_until IS NOT NULL
          AND retained_until < NOW()
          AND snapshot_id NOT IN (
              SELECT DISTINCT ON (repo_id) snapshot_id
              FROM snapshots
              ORDER BY repo_id, created_at DESC
          )
        RETURNING snapshot_id, repo_id
    `);

    const count = result.rowCount ?? 0;

    if (count > 0) {
        const repoIds = [...new Set((result.rows as { repo_id: string }[]).map(r => r.repo_id))];
        await logCleanup('snapshot_expiry', 'snapshots', count, {
            max_age_days: maxAgeDays,
            repos_affected: repoIds.length,
        });
        timer({ expired: count, repos: repoIds.length });
    }

    return count;
}

/**
 * Enforce per-repo snapshot cap. Keeps the N most recent snapshots per repo
 * and deletes older ones. FK CASCADE handles dependent rows.
 */
export async function enforceSnapshotCap(): Promise<number> {
    const maxPerRepo = retention.maxSnapshotsPerRepo;
    if (maxPerRepo <= 0) return 0;

    const timer = log.startTimer('enforceSnapshotCap');

    const result = await db.query(`
        DELETE FROM snapshots
        WHERE snapshot_id IN (
            SELECT snapshot_id FROM (
                SELECT snapshot_id,
                       ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY created_at DESC) AS rn
                FROM snapshots
            ) ranked
            WHERE rn > $1
        )
        RETURNING snapshot_id, repo_id
    `, [maxPerRepo]);

    const count = result.rowCount ?? 0;

    if (count > 0) {
        const repoIds = [...new Set((result.rows as { repo_id: string }[]).map(r => r.repo_id))];
        await logCleanup('snapshot_cap_enforcement', 'snapshots', count, {
            max_per_repo: maxPerRepo,
            repos_affected: repoIds.length,
        });
        timer({ removed: count, repos: repoIds.length, cap: maxPerRepo });
    }

    return count;
}

/**
 * Clean up transactions stuck in intermediate states for longer than the timeout.
 * Marks them as 'failed' instead of deleting, to preserve audit trail.
 */
export async function cleanupStaleTransactions(): Promise<number> {
    const timeoutMinutes = retention.staleTransactionTimeoutMinutes;
    if (timeoutMinutes <= 0) return 0;

    const timer = log.startTimer('cleanupStaleTransactions');

    // Intermediate states = anything not in a terminal state
    const terminalStates = ['committed', 'rolled_back', 'failed'];
    const placeholders = terminalStates.map((_, i) => `$${i + 2}`).join(', ');

    const result = await db.query(`
        UPDATE change_transactions
        SET state = 'failed',
            updated_at = NOW()
        WHERE state NOT IN (${placeholders})
          AND updated_at < NOW() - INTERVAL '1 minute' * $1
        RETURNING txn_id, state
    `, [timeoutMinutes, ...terminalStates]);

    const count = result.rowCount ?? 0;

    if (count > 0) {
        const stateBreakdown: Record<string, number> = {};
        for (const row of result.rows as { state: string }[]) {
            stateBreakdown[row.state] = (stateBreakdown[row.state] || 0) + 1;
        }
        await logCleanup('stale_transaction_cleanup', 'change_transactions', count, {
            timeout_minutes: timeoutMinutes,
            previous_states: stateBreakdown,
        });
        timer({ cleaned: count });
    }

    return count;
}

/**
 * Clean up orphaned data that may accumulate from partial failures.
 * Targets rows whose parent FK targets no longer exist.
 *
 * Most orphans are prevented by ON DELETE CASCADE, but edge cases exist
 * when transactions are rolled back after partial inserts.
 */
export async function cleanupOrphanedData(): Promise<number> {
    if (!retention.orphanCleanupEnabled) return 0;

    const timer = log.startTimer('cleanupOrphanedData');
    let totalCleaned = 0;

    // Evidence bundles with no referencing inferred_relations
    const evidenceResult = await db.query(`
        DELETE FROM evidence_bundles
        WHERE evidence_bundle_id NOT IN (
            SELECT DISTINCT evidence_bundle_id
            FROM inferred_relations
            WHERE evidence_bundle_id IS NOT NULL
        )
        AND generated_at < NOW() - INTERVAL '1 hour'
    `);
    const evidenceCleaned = evidenceResult.rowCount ?? 0;
    totalCleaned += evidenceCleaned;

    // Transaction file backups for terminal transactions older than 24 hours
    const backupResult = await db.query(`
        DELETE FROM transaction_file_backups
        WHERE txn_id IN (
            SELECT txn_id FROM change_transactions
            WHERE state IN ('committed', 'rolled_back', 'failed')
              AND updated_at < NOW() - INTERVAL '24 hours'
        )
    `);
    const backupsCleaned = backupResult.rowCount ?? 0;
    totalCleaned += backupsCleaned;

    if (totalCleaned > 0) {
        await logCleanup('orphan_data_cleanup', 'multiple', totalCleaned, {
            evidence_bundles: evidenceCleaned,
            transaction_file_backups: backupsCleaned,
        });
        timer({ cleaned: totalCleaned, evidence_bundles: evidenceCleaned, backups: backupsCleaned });
    }

    return totalCleaned;
}

/**
 * Run the full retention policy. Acquires an advisory lock to prevent
 * concurrent runs. Each phase runs independently — a failure in one
 * does not prevent the others from executing.
 */
export async function runRetentionPolicy(): Promise<RetentionRunResult> {
    const start = Date.now();
    const errors: string[] = [];

    // Try to acquire advisory lock (non-blocking)
    const lockResult = await db.query(
        `SELECT pg_try_advisory_lock($1) AS acquired`,
        [RETENTION_LOCK_ID],
    );
    const acquired = (lockResult.rows[0] as { acquired: boolean })?.acquired;
    if (!acquired) {
        log.info('Retention policy already running — skipping');
        return {
            snapshotsExpired: 0,
            snapshotsCapped: 0,
            staleTransactionsCleaned: 0,
            orphansCleaned: 0,
            durationMs: Date.now() - start,
            errors: ['Lock not acquired — concurrent retention run in progress'],
        };
    }

    let snapshotsExpired = 0;
    let snapshotsCapped = 0;
    let staleTransactionsCleaned = 0;
    let orphansCleaned = 0;

    try {
        // Phase 1: Stale transactions (fast, high priority)
        try {
            staleTransactionsCleaned = await cleanupStaleTransactions();
        } catch (err) {
            const wrapped = err instanceof Error ? err : new Error(String(err));
            log.error('Retention: stale transaction cleanup failed', wrapped);
            errors.push(`stale_transactions: ${wrapped.message}`);
        }

        // Phase 2: Snapshot expiry
        try {
            snapshotsExpired = await cleanupExpiredSnapshots();
        } catch (err) {
            const wrapped = err instanceof Error ? err : new Error(String(err));
            log.error('Retention: snapshot expiry failed', wrapped);
            errors.push(`snapshot_expiry: ${wrapped.message}`);
        }

        // Phase 3: Snapshot cap enforcement
        try {
            snapshotsCapped = await enforceSnapshotCap();
        } catch (err) {
            const wrapped = err instanceof Error ? err : new Error(String(err));
            log.error('Retention: snapshot cap enforcement failed', wrapped);
            errors.push(`snapshot_cap: ${wrapped.message}`);
        }

        // Phase 4: Orphan cleanup
        try {
            orphansCleaned = await cleanupOrphanedData();
        } catch (err) {
            const wrapped = err instanceof Error ? err : new Error(String(err));
            log.error('Retention: orphan cleanup failed', wrapped);
            errors.push(`orphan_cleanup: ${wrapped.message}`);
        }
    } finally {
        await db.query(`SELECT pg_advisory_unlock($1)`, [RETENTION_LOCK_ID]);
    }

    const durationMs = Date.now() - start;

    log.info('Retention policy completed', {
        snapshotsExpired,
        snapshotsCapped,
        staleTransactionsCleaned,
        orphansCleaned,
        durationMs,
        errorCount: errors.length,
    });

    return {
        snapshotsExpired,
        snapshotsCapped,
        staleTransactionsCleaned,
        orphansCleaned,
        durationMs,
        errors,
    };
}

/**
 * Get retention statistics for operational visibility.
 */
export async function getRetentionStats(): Promise<RetentionStats> {
    const [snapshotStats, staleStats, lastCleanup] = await Promise.all([
        db.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (
                    WHERE retained_until IS NOT NULL AND retained_until < NOW()
                )::int AS expired,
                MIN(created_at)::text AS oldest
            FROM snapshots
        `),
        db.query(`
            SELECT COUNT(*)::int AS stale
            FROM change_transactions
            WHERE state NOT IN ('committed', 'rolled_back', 'failed')
              AND updated_at < NOW() - INTERVAL '1 minute' * $1
        `, [retention.staleTransactionTimeoutMinutes]),
        db.query(`
            SELECT run_at::text AS last_run, details
            FROM cleanup_log
            ORDER BY run_at DESC
            LIMIT 1
        `),
    ]);

    const snapRow = snapshotStats.rows[0] as { total: number; expired: number; oldest: string | null } | undefined;
    const staleRow = staleStats.rows[0] as { stale: number } | undefined;
    const cleanupRow = lastCleanup.rows[0] as { last_run: string; details: Record<string, unknown> } | undefined;

    return {
        totalSnapshots: snapRow?.total ?? 0,
        expiredSnapshots: snapRow?.expired ?? 0,
        staleTransactions: staleRow?.stale ?? 0,
        oldestSnapshotAge: snapRow?.oldest ?? null,
        lastCleanupAt: cleanupRow?.last_run ?? null,
        lastCleanupResult: cleanupRow?.details ?? null,
    };
}

/**
 * List stale transactions for diagnostic purposes.
 */
export async function listStaleTransactions(limit: number = 20): Promise<StaleTransactionInfo[]> {
    const result = await db.query(`
        SELECT txn_id, state, updated_at::text,
               EXTRACT(EPOCH FROM (NOW() - updated_at))::int / 60 AS age_minutes
        FROM change_transactions
        WHERE state NOT IN ('committed', 'rolled_back', 'failed')
          AND updated_at < NOW() - INTERVAL '1 minute' * $1
        ORDER BY updated_at ASC
        LIMIT $2
    `, [retention.staleTransactionTimeoutMinutes, limit]);

    return result.rows as StaleTransactionInfo[];
}
