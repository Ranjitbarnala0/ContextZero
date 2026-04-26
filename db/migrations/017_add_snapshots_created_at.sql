-- Migration 017: Add snapshots.created_at for retention age queries
--
-- Earlier schemas relied on `indexed_at` to date a snapshot, but retention
-- policies and the `idx_snapshots_repo_status_created` index (migration 015)
-- need a stable creation timestamp distinct from re-index time.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Existing rows backfill via the
-- DEFAULT NOW() expression (PostgreSQL evaluates the default once per row
-- on add, but the existing rows pre-date this migration anyway).

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();

COMMENT ON COLUMN snapshots.created_at IS
    'Wall-clock time at which the snapshot row was first inserted. '
    'Distinct from indexed_at, which tracks the most recent (re)indexing run.';
