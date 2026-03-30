-- Migration 011: Production safety constraints
-- Adds CHECK constraints to enum columns, bounds to score columns, and missing indexes.

-- ─── Enum Validation ────────────────────────────────────────────────────────

-- Snapshot status must be one of the valid lifecycle states
DO $$ BEGIN
    ALTER TABLE snapshots ADD CONSTRAINT chk_snapshot_index_status
        CHECK (index_status IN ('pending', 'in_progress', 'partial', 'complete', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Behavioral profile purity classification
DO $$ BEGIN
    ALTER TABLE behavioral_profiles ADD CONSTRAINT chk_bp_purity_class
        CHECK (purity_class IN ('pure', 'read_only', 'read_write', 'side_effecting'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Effect signature classification
DO $$ BEGIN
    ALTER TABLE effect_signatures ADD CONSTRAINT chk_es_effect_class
        CHECK (effect_class IN ('pure', 'reader', 'writer', 'io', 'full_side_effect'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Structural relation types
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_relation_type
        CHECK (relation_type IN ('calls', 'imports', 'defines', 'inherits', 'implements', 'overrides', 'references', 'uses', 'decorates', 'type_references'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Structural relation source provenance
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_source
        CHECK (source IN ('static_analysis', 'runtime_trace', 'heuristic', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Change transaction state machine
DO $$ BEGIN
    ALTER TABLE change_transactions ADD CONSTRAINT chk_ct_state
        CHECK (state IN ('pending', 'patched', 'validating', 'validated', 'committing', 'committed', 'rolling_back', 'rolled_back', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Symbol visibility
DO $$ BEGIN
    ALTER TABLE symbol_versions ADD CONSTRAINT chk_sv_visibility
        CHECK (visibility IN ('public', 'private', 'protected', 'internal', 'package'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Capsule compilation mode
DO $$ BEGIN
    ALTER TABLE capsule_compilations ADD CONSTRAINT chk_cc_mode
        CHECK (mode IN ('minimal', 'standard', 'strict'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Runtime trace source
DO $$ BEGIN
    ALTER TABLE runtime_traces ADD CONSTRAINT chk_rt_trace_source
        CHECK (trace_source IN ('test_suite', 'staging', 'canary', 'production'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Dispatch edge resolution method
DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_resolution_method
        CHECK (resolution_method IN ('static_exact', 'static_inferred', 'runtime_observed', 'framework_declared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Score / Confidence Bounds ──────────────────────────────────────────────

-- Structural relations confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_confidence_bounds
        CHECK (confidence >= 0.0 AND confidence <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_strength_bounds
        CHECK (strength >= 0.0 AND strength <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Inferred relations confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE inferred_relations ADD CONSTRAINT chk_ir_confidence_bounds
        CHECK (confidence >= 0.0 AND confidence <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Evidence bundle scores [0, 1]
-- Only constrain columns that actually exist on the table.
-- Columns: semantic_score, structural_score, behavioral_score, contract_score,
--          test_score, history_score (from migration 001).
-- naming_score and composite_score do NOT exist — intentionally omitted.
DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_semantic_score
        CHECK (semantic_score >= 0.0 AND semantic_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_structural_score
        CHECK (structural_score >= 0.0 AND structural_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_behavioral_score
        CHECK (behavioral_score >= 0.0 AND behavioral_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_contract_score
        CHECK (contract_score >= 0.0 AND contract_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_test_score
        CHECK (test_score >= 0.0 AND test_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_history_score
        CHECK (history_score >= 0.0 AND history_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Dispatch edge confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_confidence_bounds
        CHECK (confidence >= 0.0 AND confidence <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Temporal risk composite score [0, 1]
DO $$ BEGIN
    ALTER TABLE temporal_risk_scores ADD CONSTRAINT chk_trs_composite_risk
        CHECK (composite_risk >= 0.0 AND composite_risk <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Temporal co-change Jaccard [0, 1]
DO $$ BEGIN
    ALTER TABLE temporal_co_changes ADD CONSTRAINT chk_tcc_jaccard
        CHECK (jaccard_coefficient >= 0.0 AND jaccard_coefficient <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Concept family member similarity [0, 1]
DO $$ BEGIN
    ALTER TABLE concept_family_members ADD CONSTRAINT chk_cfm_similarity
        CHECK (similarity_to_exemplar >= 0.0 AND similarity_to_exemplar <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Symbol lineage rename confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE symbol_lineage ADD CONSTRAINT chk_sl_rename_confidence
        CHECK (rename_confidence IS NULL OR (rename_confidence >= 0.0 AND rename_confidence <= 1.0));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Concept Family Member Role Mutual Exclusivity ──────────────────────────

DO $$ BEGIN
    ALTER TABLE concept_family_members ADD CONSTRAINT chk_cfm_role_exclusivity
        CHECK ((is_exemplar::int + is_outlier::int + is_contradicting::int) <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Range Validation for Symbol Versions ───────────────────────────────────

DO $$ BEGIN
    ALTER TABLE symbol_versions ADD CONSTRAINT chk_sv_line_range
        CHECK (range_start_line >= 0 AND range_end_line >= range_start_line);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Missing Performance Indexes ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_files_language ON files (language);
CREATE INDEX IF NOT EXISTS idx_snapshots_index_status ON snapshots (index_status);
CREATE INDEX IF NOT EXISTS idx_runtime_traces_source ON runtime_traces (trace_source);
CREATE INDEX IF NOT EXISTS idx_temporal_risk_scores_symbol ON temporal_risk_scores (symbol_id);
CREATE INDEX IF NOT EXISTS idx_change_transactions_state ON change_transactions (state);
