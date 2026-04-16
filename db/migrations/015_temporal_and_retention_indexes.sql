-- Migration 015: BRIN indexes for temporal tables and retention query optimization
--
-- 1. BRIN indexes on temporal tables (naturally ordered by insertion time)
-- 2. Composite index on snapshots for retention age queries
-- 3. Partial index on symbol_lineage for active lineage queries
-- 4. Covering index on cleanup_log for recent-run lookups

-- ─── BRIN Indexes for Temporal Tables ────────────────────────────────────────
-- BRIN (Block Range INdex) is ideal for append-only temporal data where
-- physical ordering correlates with logical ordering. Much smaller than B-tree
-- while supporting range scans efficiently.

-- NOTE: each temporal table has its own insertion-ordered timestamp column
-- (computed_at / first_observed / created_at). They are all NOT NULL and
-- populated at INSERT time, so BRIN works on all of them.

CREATE INDEX IF NOT EXISTS idx_temporal_co_changes_computed_brin
    ON temporal_co_changes USING brin (computed_at)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_temporal_risk_scores_computed_brin
    ON temporal_risk_scores USING brin (computed_at)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_runtime_observed_edges_observed_brin
    ON runtime_observed_edges USING brin (first_observed)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_runtime_traces_created_brin
    ON runtime_traces USING brin (created_at)
    WITH (pages_per_range = 32);

-- ─── Symbol Lineage Active Records ──────────────────────────────────────────
-- Most lineage queries filter for alive symbols — partial index avoids dead rows

CREATE INDEX IF NOT EXISTS idx_symbol_lineage_alive
    ON symbol_lineage (repo_id, canonical_name)
    WHERE is_alive = true;

-- ─── Cleanup Log Recent Lookups ─────────────────────────────────────────────
-- Retention stats query needs the most recent cleanup run per operation type

CREATE INDEX IF NOT EXISTS idx_cleanup_log_operation_run
    ON cleanup_log (operation, run_at DESC);

-- ─── Snapshot Lifecycle Composite ───────────────────────────────────────────
-- Supports retention expiry queries that filter by repo + status + age

CREATE INDEX IF NOT EXISTS idx_snapshots_repo_status_created
    ON snapshots (repo_id, index_status, created_at DESC);
