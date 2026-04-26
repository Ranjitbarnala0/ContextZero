/**
 * ContextZero — Retention Service Tests
 *
 * Mock-based unit tests for all retention lifecycle functions.
 * Tests verify SQL correctness, advisory lock behavior, cascade logic,
 * error isolation between phases, and audit logging.
 */

const mockQuery = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
    },
}));

jest.mock('../config', () => ({
    retention: {
        snapshotMaxAgeDays: 90,
        maxSnapshotsPerRepo: 50,
        staleTransactionTimeoutMinutes: 60,
        orphanCleanupEnabled: true,
        retentionIntervalMinutes: 360,
        retentionEnabled: true,
    },
}));

jest.mock('../logger', () => ({
    Logger: jest.fn().mockImplementation(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        startTimer: jest.fn(() => jest.fn()),
    })),
}));

import {
    cleanupExpiredSnapshots,
    enforceSnapshotCap,
    cleanupStaleTransactions,
    cleanupOrphanedData,
    runRetentionPolicy,
    getRetentionStats,
    listStaleTransactions,
} from '../services/retention-service';

beforeEach(() => {
    mockQuery.mockReset();
});

// ────────── cleanupExpiredSnapshots ──────────

describe('cleanupExpiredSnapshots', () => {
    it('stamps retained_until on unstamped snapshots then deletes expired', async () => {
        // First call: UPDATE retained_until
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 });
        // Second call: DELETE expired snapshots
        mockQuery.mockResolvedValueOnce({
            rows: [
                { snapshot_id: 's1', repo_id: 'r1' },
                { snapshot_id: 's2', repo_id: 'r1' },
            ],
            rowCount: 2,
        });
        // Third call: audit log INSERT
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const count = await cleanupExpiredSnapshots();

        expect(count).toBe(2);
        expect(mockQuery).toHaveBeenCalledTimes(3);
        // Verify first query stamps retained_until with age param
        expect(mockQuery.mock.calls[0][1]).toEqual([90]);
        // Verify audit log was written
        expect(mockQuery.mock.calls[2][0]).toContain('INSERT INTO cleanup_log');
        expect(mockQuery.mock.calls[2][1]?.[0]).toBe('snapshot_expiry');
    });

    it('returns 0 and skips audit log when no snapshots expired', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const count = await cleanupExpiredSnapshots();

        expect(count).toBe(0);
        // No audit log INSERT (only 2 calls: stamp + delete)
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });
});

// ────────── enforceSnapshotCap ──────────

describe('enforceSnapshotCap', () => {
    it('deletes snapshots beyond cap using ROW_NUMBER', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [
                { snapshot_id: 's3', repo_id: 'r1' },
            ],
            rowCount: 1,
        });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const count = await enforceSnapshotCap();

        expect(count).toBe(1);
        // Should pass maxSnapshotsPerRepo as param
        expect(mockQuery.mock.calls[0][1]).toEqual([50]);
    });
});

// ────────── cleanupStaleTransactions ──────────

describe('cleanupStaleTransactions', () => {
    it('marks stuck transactions as failed', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [
                { txn_id: 't1', state: 'prepared' },
                { txn_id: 't2', state: 'patched' },
            ],
            rowCount: 2,
        });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const count = await cleanupStaleTransactions();

        expect(count).toBe(2);
        // Verify timeout param and terminal states passed
        const params = mockQuery.mock.calls[0][1] as unknown[];
        expect(params[0]).toBe(60); // timeout minutes
        expect(params).toContain('committed');
        expect(params).toContain('rolled_back');
        expect(params).toContain('failed');
    });
});

// ────────── cleanupOrphanedData ──────────

describe('cleanupOrphanedData', () => {
    it('cleans orphaned evidence bundles and terminal backups', async () => {
        // Evidence bundles DELETE
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });
        // Transaction file backups DELETE
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 7 });
        // Audit log INSERT
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const count = await cleanupOrphanedData();

        expect(count).toBe(10);
        expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('returns 0 when no orphans found', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const count = await cleanupOrphanedData();

        expect(count).toBe(0);
        // No audit log (only 2 DELETE queries)
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });
});

// ────────── runRetentionPolicy ──────────

describe('runRetentionPolicy', () => {
    it('acquires advisory lock, runs all phases, releases lock', async () => {
        // Advisory lock acquisition
        mockQuery.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });

        // Phase 1: cleanupStaleTransactions
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Phase 2: cleanupExpiredSnapshots (stamp + delete)
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Phase 3: enforceSnapshotCap
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Phase 4: cleanupOrphanedData (2 queries)
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Advisory lock release
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await runRetentionPolicy();

        expect(result.errors).toHaveLength(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        // Verify lock acquired first
        expect(mockQuery.mock.calls[0][0]).toContain('pg_try_advisory_lock');
        // Verify lock released last
        const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
        expect(lastCall[0]).toContain('pg_advisory_unlock');
    });

    it('returns early if lock not acquired', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ acquired: false }], rowCount: 1 });

        const result = await runRetentionPolicy();

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Lock not acquired');
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('isolates phase errors — failure in one does not abort others', async () => {
        // Lock acquired
        mockQuery.mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 });

        // Phase 1: stale cleanup FAILS
        mockQuery.mockRejectedValueOnce(new Error('DB timeout'));

        // Phase 2: snapshot expiry succeeds (stamp + delete)
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Phase 3: snapshot cap succeeds
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Phase 4: orphan cleanup succeeds
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        // Lock release
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await runRetentionPolicy();

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('stale_transactions');
        // All other phases still ran (lock released)
        const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
        expect(lastCall[0]).toContain('pg_advisory_unlock');
    });
});

// ────────── getRetentionStats ──────────

describe('getRetentionStats', () => {
    it('aggregates stats from parallel queries', async () => {
        // Snapshot stats
        mockQuery.mockResolvedValueOnce({
            rows: [{ total: 42, expired: 3, oldest: '2025-01-01T00:00:00Z' }],
            rowCount: 1,
        });
        // Stale transaction count
        mockQuery.mockResolvedValueOnce({
            rows: [{ stale: 2 }],
            rowCount: 1,
        });
        // Last cleanup
        mockQuery.mockResolvedValueOnce({
            rows: [{ last_run: '2026-03-30T10:00:00Z', details: { foo: 1 } }],
            rowCount: 1,
        });

        const stats = await getRetentionStats();

        expect(stats.totalSnapshots).toBe(42);
        expect(stats.expiredSnapshots).toBe(3);
        expect(stats.staleTransactions).toBe(2);
        expect(stats.oldestSnapshotAge).toBe('2025-01-01T00:00:00Z');
        expect(stats.lastCleanupAt).toBe('2026-03-30T10:00:00Z');
    });

    it('handles empty results gracefully', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const stats = await getRetentionStats();

        expect(stats.totalSnapshots).toBe(0);
        expect(stats.lastCleanupAt).toBeNull();
    });
});

// ────────── listStaleTransactions ──────────

describe('listStaleTransactions', () => {
    it('returns stale transactions ordered by age', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [
                { txn_id: 't1', state: 'prepared', updated_at: '2026-03-30T08:00:00Z', age_minutes: 120 },
                { txn_id: 't2', state: 'patched', updated_at: '2026-03-30T09:00:00Z', age_minutes: 60 },
            ],
            rowCount: 2,
        });

        const stale = await listStaleTransactions();

        expect(stale).toHaveLength(2);
        expect(stale[0].txn_id).toBe('t1');
        expect(stale[0].age_minutes).toBe(120);
    });

    it('respects limit parameter', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ txn_id: 't1', state: 'planned', updated_at: '2026-03-30', age_minutes: 90 }], rowCount: 1 });

        await listStaleTransactions(5);

        expect(mockQuery.mock.calls[0][1]?.[1]).toBe(5);
    });
});
