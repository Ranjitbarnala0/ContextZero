-- Migration 014: Retention policy support and lifecycle management
--
-- 1. Add retained_until column to snapshots for policy-based expiry
-- 2. Create cleanup_log table for retention audit trail
-- 3. Add index on snapshots(repo_id, created_at) for efficient age-based queries
-- 4. Add index on change_transactions(state, updated_at) for stale cleanup

-- ─── Snapshot Lifecycle Columns ──────────────────────────────────────────────
-- `created_at` is required by the `idx_snapshots_repo_created` index below
-- and by 015's `idx_snapshots_repo_status_created`. Originally added in a
-- later migration (017), but the indexes in 014/015 reference it — so we add
-- it here (idempotent) to make a fresh-DB bootstrap succeed in correct order.
-- Migration 017's `ADD COLUMN IF NOT EXISTS` becomes a no-op when 014 has
-- already added the column.
--
-- `retained_until`: NULL means "retain indefinitely" (default). When a
-- retention policy runs, it stamps retained_until with the computed expiry
-- timestamp. Snapshots past their retained_until are eligible for cleanup
-- on the next cycle.

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS retained_until TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN snapshots.retained_until IS
    'Policy-computed expiry timestamp. NULL = retain indefinitely. '
    'Snapshots past this timestamp are eligible for cleanup.';

-- ─── Cleanup Audit Log ───────────────────────────────────────────────────────
-- Every retention run records what it did for operational visibility.

CREATE TABLE IF NOT EXISTS cleanup_log (
    cleanup_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operation           TEXT NOT NULL,
    target_table        TEXT NOT NULL,
    rows_affected       INTEGER NOT NULL DEFAULT 0,
    details             JSONB DEFAULT NULL,

    CONSTRAINT chk_cleanup_operation CHECK (
        operation IN (
            'snapshot_expiry',
            'stale_transaction_cleanup',
            'orphan_data_cleanup',
            'snapshot_cap_enforcement'
        )
    ),
    CONSTRAINT chk_cleanup_rows_affected CHECK (rows_affected >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_run_at
    ON cleanup_log (run_at DESC);

COMMENT ON TABLE cleanup_log IS
    'Audit trail for retention policy runs. Each row records one cleanup operation.';

-- ─── Performance Indexes for Retention Queries ───────────────────────────────

-- Age-based snapshot queries: "find oldest snapshots for repo X"
CREATE INDEX IF NOT EXISTS idx_snapshots_repo_created
    ON snapshots (repo_id, created_at);

-- Stale transaction detection: "find stuck transactions older than threshold"
CREATE INDEX IF NOT EXISTS idx_change_transactions_state_updated
    ON change_transactions (state, updated_at)
    WHERE state NOT IN ('committed', 'rolled_back');

-- Retained_until expiry scan: "find snapshots past their retention window"
CREATE INDEX IF NOT EXISTS idx_snapshots_retained_until
    ON snapshots (retained_until)
    WHERE retained_until IS NOT NULL;
