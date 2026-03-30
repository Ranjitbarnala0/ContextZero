-- Migration 012: Fix constraint mismatches between migration 011 and application types
--
-- Migration 011 introduced CHECK constraints with enum values that do not match
-- the TypeScript type definitions. This migration drops the incorrect constraints
-- and re-creates them with the correct values from src/types.ts.

-- ─── Drop Incorrect Constraints ─────────────────────────────────────────────

-- Snapshot index_status: 011 used 'in_progress', code uses 'indexing'
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS chk_snapshot_index_status;

-- Change transaction state: 011 used (pending, validating, committing, rolling_back),
-- code uses (planned, prepared, reindexed, propagation_pending)
ALTER TABLE change_transactions DROP CONSTRAINT IF EXISTS chk_ct_state;

-- Structural relation type: 011 used (uses, decorates, type_references),
-- code uses (called_by, exports, typed_as)
ALTER TABLE structural_relations DROP CONSTRAINT IF EXISTS chk_sr_relation_type;

-- Runtime trace source: 011 used (test_suite, staging, canary, production),
-- code uses (test_execution, dev_run, ci_trace, production_sample)
ALTER TABLE runtime_traces DROP CONSTRAINT IF EXISTS chk_rt_trace_source;

-- Dispatch edge resolution method: 011 used (static_exact, static_inferred, runtime_observed, framework_declared),
-- code uses (type_annotation, constructor_assignment, field_inference, inheritance_mro, runtime_observed, unresolved)
ALTER TABLE dispatch_edges DROP CONSTRAINT IF EXISTS chk_de_resolution_method;

-- Evidence bundles: 011 originally referenced non-existent columns naming_score and composite_score.
-- Fixed in 011 to use test_score and history_score instead. Drop legacy names if somehow present.
ALTER TABLE evidence_bundles DROP CONSTRAINT IF EXISTS chk_eb_naming_score;
ALTER TABLE evidence_bundles DROP CONSTRAINT IF EXISTS chk_eb_composite_score;

-- ─── Re-create With Correct Values ──────────────────────────────────────────

-- Snapshot index_status — matches IndexStatus type in types.ts:39
DO $$ BEGIN
    ALTER TABLE snapshots ADD CONSTRAINT chk_snapshot_index_status
        CHECK (index_status IN ('pending', 'indexing', 'complete', 'failed', 'partial'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Change transaction state — matches TransactionState type in types.ts:34-37
DO $$ BEGIN
    ALTER TABLE change_transactions ADD CONSTRAINT chk_ct_state
        CHECK (state IN (
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending',
            'committed', 'rolled_back', 'failed'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Structural relation type — matches StructuralRelationType type in types.ts:18-23
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_relation_type
        CHECK (relation_type IN (
            'calls', 'called_by', 'references', 'defines',
            'imports', 'exports', 'implements', 'inherits',
            'typed_as', 'overrides'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Runtime trace source — matches TraceSource type in types.ts:49
DO $$ BEGIN
    ALTER TABLE runtime_traces ADD CONSTRAINT chk_rt_trace_source
        CHECK (trace_source IN ('test_execution', 'dev_run', 'ci_trace', 'production_sample'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Dispatch edge resolution method — matches DispatchResolutionMethod type in types.ts:48
DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_resolution_method
        CHECK (resolution_method IN (
            'type_annotation', 'constructor_assignment', 'field_inference',
            'inheritance_mro', 'runtime_observed', 'unresolved'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
