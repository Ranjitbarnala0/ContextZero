-- ContextZero bugfix migration 008
-- Fixes:
--   1. runtime_observed_edges: add UNIQUE constraint so ON CONFLICT DO NOTHING
--      actually fires (the PK is a fresh UUID, so without a UNIQUE constraint
--      every INSERT succeeds and duplicates accumulate).
--   2. runtime_observed_edges: add index on trace_id for cascade deletes.
--   3. invariants: add missing index on last_verified_snapshot_id.

-- 1. UNIQUE constraint on runtime_observed_edges
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_runtime_observed_edges_trace_caller_callee') THEN
        ALTER TABLE runtime_observed_edges
            ADD CONSTRAINT uq_runtime_observed_edges_trace_caller_callee
            UNIQUE (trace_id, caller_symbol_version_id, callee_symbol_version_id);
    END IF;
END $$;

-- 2. Index on trace_id for cascade deletes from runtime_traces
CREATE INDEX IF NOT EXISTS idx_runtime_observed_edges_trace_id
    ON runtime_observed_edges(trace_id);

-- 3. Missing index on invariants.last_verified_snapshot_id
CREATE INDEX IF NOT EXISTS idx_invariants_last_verified_snapshot
    ON invariants(last_verified_snapshot_id);

-- 4. UNIQUE constraint on dispatch_edges to prevent duplicates
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_dispatch_edges_snapshot_caller_receiver') THEN
        ALTER TABLE dispatch_edges
            ADD CONSTRAINT uq_dispatch_edges_snapshot_caller_receiver
            UNIQUE (snapshot_id, caller_symbol_version_id, receiver_expression);
    END IF;
END $$;
