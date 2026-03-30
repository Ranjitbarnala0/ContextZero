-- Migration 013: Index deduplication, missing indexes, and evidence_bundles integrity
--
-- 1. Drop 3 duplicate index pairs (each created in two separate migrations)
-- 2. Add missing indexes for common query patterns
-- 3. Add UNIQUE constraint on evidence_bundles to prevent duplicate bundles

-- ─── Drop Duplicate Indexes ────────────────────────────────────────────────
-- Each pair has the same definition; keep the one with the clearer name.

-- effect_signatures: idx_effects_sv (007) duplicated by idx_effect_sig_sv (010)
DROP INDEX IF EXISTS idx_effects_sv;

-- test_artifacts GIN(related_symbols): idx_test_artifacts_related (002) duplicated by idx_ta_related_symbols (010)
DROP INDEX IF EXISTS idx_test_artifacts_related;

-- temporal_risk_scores: idx_risk_symbol (007) duplicated by idx_temporal_risk_scores_symbol (011)
DROP INDEX IF EXISTS idx_risk_symbol;

-- ─── Add Missing Indexes ───────────────────────────────────────────────────

-- change_transactions.base_snapshot_id — queried during transaction validation and listing
CREATE INDEX IF NOT EXISTS idx_change_transactions_base_snapshot
    ON change_transactions (base_snapshot_id);

-- invariants.repo_id — filtered in many queries (getInvariantsForSymbol, mineInvariants)
CREATE INDEX IF NOT EXISTS idx_invariants_repo
    ON invariants (repo_id);

-- inferred_relations.evidence_bundle_id — joined during homolog queries
CREATE INDEX IF NOT EXISTS idx_inferred_relations_evidence_bundle
    ON inferred_relations (evidence_bundle_id);

-- capsule_compilations lookup by symbol + snapshot (common cache check)
CREATE INDEX IF NOT EXISTS idx_capsule_compilations_sv_snapshot
    ON capsule_compilations (symbol_version_id, snapshot_id);

-- ─── Evidence Bundle Deduplication ─────────────────────────────────────────
-- Prevent identical evidence bundles from accumulating.
-- Two bundles are considered duplicates if they share all six score dimensions.
DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT uq_evidence_bundle_scores
        UNIQUE (semantic_score, structural_score, behavioral_score,
                contract_score, test_score, history_score);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
