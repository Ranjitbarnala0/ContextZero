-- Migration 010: Performance indexes for production-scale queries

CREATE INDEX IF NOT EXISTS idx_sv_snapshot_kind
ON symbol_versions (snapshot_id, symbol_version_id);

CREATE INDEX IF NOT EXISTS idx_symbols_kind
ON symbols (kind, repo_id);

CREATE INDEX IF NOT EXISTS idx_sr_dst_type
ON structural_relations (dst_symbol_version_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_effect_sig_sv
ON effect_signatures (symbol_version_id);

CREATE INDEX IF NOT EXISTS idx_ir_confidence_type
ON inferred_relations (confidence, relation_type);

CREATE INDEX IF NOT EXISTS idx_invariants_scope_verified
ON invariants (scope_symbol_id, last_verified_snapshot_id DESC);

CREATE INDEX IF NOT EXISTS idx_ta_related_symbols
ON test_artifacts USING GIN (related_symbols);
