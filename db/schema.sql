-- ContextZero Database Schema
-- Generated from db/migrations/*.sql. Do not hand-edit.
-- Generated at 2026-03-30T09:29:21.264Z
-- Dropped tables excluded: semantic_profiles

-- >>> 001_initial_schema.sql

-- ContextZero Database Schema (PostgreSQL)
-- Defines the structural truth, behavioral profiles, contracts, and inferred relations.

-- Required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Repositories and Snapshots
CREATE TABLE repositories (
    repo_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    default_branch VARCHAR(255) NOT NULL,
    visibility VARCHAR(50) NOT NULL,
    language_set TEXT[] NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE snapshots (
    snapshot_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    commit_sha VARCHAR(40) NOT NULL,
    branch VARCHAR(255) NOT NULL,
    parent_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    index_status VARCHAR(50) NOT NULL,
    UNIQUE (repo_id, commit_sha)
);

-- 2. Files and Scope
CREATE TABLE files (
    file_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    language VARCHAR(50) NOT NULL,
    parse_status VARCHAR(50) NOT NULL,
    UNIQUE (snapshot_id, path)
);

-- 3. Symbols
CREATE TABLE symbols (
    symbol_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL,
    canonical_name VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    logical_namespace TEXT,
    UNIQUE (repo_id, stable_key)
);

CREATE TABLE symbol_versions (
    symbol_version_id UUID PRIMARY KEY,
    symbol_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    range_start_line INT NOT NULL,
    range_start_col INT NOT NULL,
    range_end_line INT NOT NULL,
    range_end_col INT NOT NULL,
    signature TEXT,
    ast_hash VARCHAR(64) NOT NULL,
    body_hash VARCHAR(64) NOT NULL,
    summary TEXT,
    visibility VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL,
    uncertainty_flags TEXT[],
    UNIQUE (symbol_id, snapshot_id)
);

-- 4. Graphs and Relations
CREATE TABLE structural_relations (
    relation_id UUID PRIMARY KEY,
    src_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    dst_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 1.0,
    source VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    UNIQUE (src_symbol_version_id, dst_symbol_version_id, relation_type)
);

-- 5. Behavioral, Contract, and Semantic Profiles
CREATE TABLE behavioral_profiles (
    behavior_profile_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    purity_class VARCHAR(50) NOT NULL,
    resource_touches TEXT[],
    db_reads TEXT[],
    db_writes TEXT[],
    network_calls TEXT[],
    cache_ops TEXT[],
    file_io TEXT[],
    auth_operations TEXT[],
    validation_operations TEXT[],
    exception_profile TEXT[],
    state_mutation_profile TEXT[],
    transaction_profile TEXT[],
    UNIQUE(symbol_version_id)
);

CREATE TABLE contract_profiles (
    contract_profile_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    input_contract TEXT,
    output_contract TEXT,
    error_contract TEXT,
    schema_refs TEXT[],
    api_contract_refs TEXT[],
    serialization_contract TEXT,
    security_contract TEXT,
    derived_invariants_count INT NOT NULL DEFAULT 0,
    UNIQUE(symbol_version_id)
);

CREATE TABLE invariants (
    invariant_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    scope_symbol_id UUID REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    scope_level VARCHAR(50) NOT NULL,
    expression TEXT NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 1.0,
    validation_method VARCHAR(50) NOT NULL,
    last_verified_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL
);

-- [omitted] CREATE TABLE semantic_profiles — dropped by later migration

-- 6. Homolog Inference and Evidence
CREATE TABLE evidence_bundles (
    evidence_bundle_id UUID PRIMARY KEY,
    semantic_score FLOAT NOT NULL,
    structural_score FLOAT NOT NULL,
    behavioral_score FLOAT NOT NULL,
    contract_score FLOAT NOT NULL,
    test_score FLOAT NOT NULL,
    history_score FLOAT NOT NULL,
    contradiction_flags TEXT[],
    feature_payload JSONB NOT NULL,
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE inferred_relations (
    inferred_relation_id UUID PRIMARY KEY,
    src_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    dst_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    review_state VARCHAR(50) NOT NULL,
    evidence_bundle_id UUID NOT NULL REFERENCES evidence_bundles(evidence_bundle_id) ON DELETE CASCADE,
    valid_from_snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    valid_to_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    UNIQUE (src_symbol_version_id, dst_symbol_version_id, relation_type, valid_from_snapshot_id)
);

-- 7. Tests and Transactions
CREATE TABLE test_artifacts (
    test_artifact_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    framework VARCHAR(50) NOT NULL,
    related_symbols TEXT[],
    assertion_summary TEXT,
    coverage_hints JSONB,
    UNIQUE(symbol_version_id)
);

CREATE TABLE change_transactions (
    txn_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    base_snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    created_by VARCHAR(255) NOT NULL,
    state VARCHAR(50) NOT NULL,
    target_symbol_versions TEXT[],
    patches JSONB NOT NULL,
    impact_report_ref VARCHAR(255),
    validation_report_ref VARCHAR(255),
    propagation_report_ref VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_files_snapshot_id ON files(snapshot_id);
CREATE INDEX idx_symbol_versions_symbol_id ON symbol_versions(symbol_id);
CREATE INDEX idx_symbol_versions_snapshot_id ON symbol_versions(snapshot_id);
CREATE INDEX idx_structural_relations_src ON structural_relations(src_symbol_version_id);
CREATE INDEX idx_structural_relations_dst ON structural_relations(dst_symbol_version_id);
CREATE INDEX idx_inferred_relations_src ON inferred_relations(src_symbol_version_id);
CREATE INDEX idx_inferred_relations_dst ON inferred_relations(dst_symbol_version_id);

-- Query optimization indexes
CREATE INDEX idx_symbols_repo_canonical ON symbols(repo_id, canonical_name);
CREATE INDEX idx_symbols_canonical_name_trgm ON symbols USING gin (canonical_name gin_trgm_ops);
CREATE INDEX idx_invariants_scope_symbol ON invariants(scope_symbol_id);
CREATE INDEX idx_change_transactions_repo_state ON change_transactions(repo_id, state);
CREATE INDEX idx_symbol_versions_file_id ON symbol_versions(file_id);

-- >>> 002_production_hardening.sql

-- Migration 002: ContextZero Production Hardening
-- Date: 2026-03-13
-- Description: JSONB report columns, file backup table, semantic vectors,
--              IDF corpus, normalized AST hashes, performance indexes, auto-updated_at triggers.

-- ============================================================
-- 1. Fix report columns: VARCHAR(255) -> JSONB with NULL defaults
-- ============================================================
ALTER TABLE change_transactions ALTER COLUMN impact_report_ref TYPE JSONB USING impact_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN validation_report_ref TYPE JSONB USING validation_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN propagation_report_ref TYPE JSONB USING propagation_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN impact_report_ref SET DEFAULT NULL;
ALTER TABLE change_transactions ALTER COLUMN validation_report_ref SET DEFAULT NULL;
ALTER TABLE change_transactions ALTER COLUMN propagation_report_ref SET DEFAULT NULL;

-- ============================================================
-- 2. Add repository base_path column
-- ============================================================
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS base_path TEXT;

-- ============================================================
-- 3. Add transaction_file_backups table for persistent rollback
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_file_backups (
    backup_id UUID PRIMARY KEY,
    txn_id UUID NOT NULL REFERENCES change_transactions(txn_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_content TEXT,  -- NULL means file didn't exist before
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_file_backups_txn ON transaction_file_backups(txn_id);

-- ============================================================
-- 4. Add normalized_ast_hash to symbol_versions
-- ============================================================
ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS normalized_ast_hash VARCHAR(64);

-- ============================================================
-- 5. Add semantic_vectors table for native TF-IDF embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS semantic_vectors (
    vector_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,  -- 'name', 'body', 'signature', 'behavior', 'contract'
    sparse_vector JSONB NOT NULL,  -- {token: tfidf_score, ...}
    minhash_signature BIGINT[] NOT NULL,  -- MinHash for LSH (values can exceed signed int32 range)
    token_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(symbol_version_id, view_type)
);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_sv ON semantic_vectors(symbol_version_id);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_view ON semantic_vectors(view_type);

-- ============================================================
-- 6. Add idf_corpus table for inverse document frequency stats
-- ============================================================
CREATE TABLE IF NOT EXISTS idf_corpus (
    corpus_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,
    document_count INTEGER NOT NULL,
    token_document_counts JSONB NOT NULL,  -- {token: doc_count, ...}
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(snapshot_id, view_type)
);

-- ============================================================
-- 7. Add missing performance indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sv_body_hash ON symbol_versions(body_hash);
CREATE INDEX IF NOT EXISTS idx_sv_ast_hash ON symbol_versions(ast_hash);
CREATE INDEX IF NOT EXISTS idx_sv_normalized_ast_hash ON symbol_versions(normalized_ast_hash);
CREATE INDEX IF NOT EXISTS idx_bp_purity_class ON behavioral_profiles(purity_class);
CREATE INDEX IF NOT EXISTS idx_test_artifacts_related ON test_artifacts USING gin(related_symbols);

-- ============================================================
-- 8. Add updated_at auto-trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_repositories_updated_at
    BEFORE UPDATE ON repositories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_change_transactions_updated_at
    BEFORE UPDATE ON change_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- >>> 003_remove_dead_tables.sql

-- Migration 003: Remove dead tables
-- The semantic_profiles table was superseded by semantic_vectors (native TF-IDF embeddings).

DROP TABLE IF EXISTS semantic_profiles;

-- >>> 004_lsh_bands.sql

-- Migration 004: LSH Banding table for sub-linear semantic candidate retrieval
-- Locality-Sensitive Hashing bands for MinHash signatures.
--
-- Each symbol_version's MinHash signature is split into bands of R consecutive
-- rows. Each band produces one hash. Two symbols sharing any (view_type, band_index, band_hash)
-- are LSH candidates, enabling O(matches) retrieval instead of O(N) full scan.

CREATE TABLE IF NOT EXISTS lsh_bands (
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type TEXT NOT NULL,
    band_index SMALLINT NOT NULL,
    band_hash INTEGER NOT NULL,
    PRIMARY KEY (symbol_version_id, view_type, band_index)
);

CREATE INDEX idx_lsh_bands_lookup ON lsh_bands (view_type, band_index, band_hash);

-- >>> 005_body_source.sql

-- Migration 005: Add body_source to symbol_versions
--
-- Stores the actual source code body of each symbol version directly in the DB.
-- This transforms ContextZero from a metadata index into a self-contained
-- code knowledge base — enabling:
--   1. Symbol-scoped code serving without disk I/O
--   2. Accurate body-view TF-IDF embeddings (was using summaries)
--   3. Semantic code search against actual source
--   4. Rich context capsules with real code in all nodes
--   5. Docker/remote compatibility (no repo mount needed for queries)

ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS body_source TEXT;

-- >>> 006_invariant_dedup.sql

-- Migration 006: Deduplicate invariants
--
-- The invariants table had no UNIQUE constraint on (repo_id, scope_symbol_id, expression),
-- so each re-ingestion created duplicate invariant rows. This caused blast radius
-- contract dimension to return duplicate impacts.

-- Step 1: Remove duplicates, keeping the one with the highest strength
DELETE FROM invariants a
USING invariants b
WHERE a.invariant_id > b.invariant_id
  AND a.repo_id = b.repo_id
  AND a.scope_symbol_id IS NOT DISTINCT FROM b.scope_symbol_id
  AND a.expression = b.expression;

-- Step 2: Add UNIQUE constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_invariants_dedup
    ON invariants (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression);

-- >>> 007_v2_upgrade.sql

-- ContextZero V2 Upgrade — Full schema evolution
-- Adds: symbol lineage, dispatch edges, effect signatures, concept families,
-- temporal co-changes, runtime evidence, enhanced provenance tracking.
--
-- Non-destructive: all existing tables preserved and extended.

-- ============================================================================
-- 1. SYMBOL LINEAGE — persistent identity across snapshots/restarts
-- ============================================================================

CREATE TABLE symbol_lineage (
    lineage_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    -- Deterministic seed built from (repo, language, kind, ancestry, name, signature, path)
    identity_seed VARCHAR(128) NOT NULL,
    canonical_name VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL,
    -- Lifecycle
    birth_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    death_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    -- Rename/move tracking
    previous_lineage_id UUID REFERENCES symbol_lineage(lineage_id) ON DELETE SET NULL,
    rename_confidence FLOAT,
    -- Status
    is_alive BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, identity_seed)
);

CREATE INDEX idx_lineage_repo_alive ON symbol_lineage(repo_id, is_alive);
CREATE INDEX idx_lineage_canonical ON symbol_lineage(repo_id, canonical_name);
CREATE INDEX idx_lineage_kind ON symbol_lineage(repo_id, kind);

-- Link symbols to their lineage chain
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS lineage_id UUID REFERENCES symbol_lineage(lineage_id) ON DELETE SET NULL;
CREATE INDEX idx_symbols_lineage ON symbols(lineage_id);

-- ============================================================================
-- 2. DISPATCH EDGES — object-aware method resolution
-- ============================================================================

CREATE TABLE dispatch_edges (
    dispatch_edge_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Source: the callsite
    caller_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- The expression chain, e.g. "self.service.validate"
    receiver_expression TEXT NOT NULL,
    -- Inferred receiver type(s)
    receiver_types TEXT[] NOT NULL DEFAULT '{}',
    -- Resolved target(s) — may have multiple for polymorphic dispatch
    resolved_symbol_version_ids UUID[] NOT NULL DEFAULT '{}',
    -- Resolution metadata
    resolution_method VARCHAR(50) NOT NULL, -- 'type_annotation', 'constructor_assignment', 'field_inference', 'inheritance_mro', 'runtime_observed', 'unresolved'
    confidence FLOAT NOT NULL DEFAULT 0.5,
    is_polymorphic BOOLEAN NOT NULL DEFAULT FALSE,
    -- For inheritance dispatch
    class_hierarchy_depth INT,
    override_chain UUID[], -- ordered list of overriding symbol_version_ids
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dispatch_caller ON dispatch_edges(caller_symbol_version_id);
CREATE INDEX idx_dispatch_snapshot ON dispatch_edges(snapshot_id);
CREATE INDEX idx_dispatch_resolved ON dispatch_edges USING gin(resolved_symbol_version_ids);
CREATE INDEX idx_dispatch_receiver ON dispatch_edges(snapshot_id, receiver_expression);

-- Class hierarchy for dispatch resolution
CREATE TABLE class_hierarchy (
    hierarchy_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    class_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    parent_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Method Resolution Order position (0 = self, 1 = first parent, etc.)
    mro_position INT NOT NULL DEFAULT 0,
    relation_kind VARCHAR(30) NOT NULL, -- 'extends', 'implements', 'mixin', 'protocol'
    UNIQUE (snapshot_id, class_symbol_version_id, parent_symbol_version_id)
);

CREATE INDEX idx_hierarchy_class ON class_hierarchy(class_symbol_version_id);
CREATE INDEX idx_hierarchy_parent ON class_hierarchy(parent_symbol_version_id);
CREATE INDEX idx_hierarchy_snapshot ON class_hierarchy(snapshot_id);

-- ============================================================================
-- 3. EFFECT SIGNATURES — typed effect system
-- ============================================================================

CREATE TABLE effect_signatures (
    effect_signature_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Structured effects as typed entries
    effects JSONB NOT NULL DEFAULT '[]',
    -- Summary classification
    effect_class VARCHAR(50) NOT NULL, -- 'pure', 'reader', 'writer', 'io', 'full_side_effect'
    -- Resource summary
    reads_resources TEXT[] NOT NULL DEFAULT '{}',
    writes_resources TEXT[] NOT NULL DEFAULT '{}',
    emits_events TEXT[] NOT NULL DEFAULT '{}',
    calls_external TEXT[] NOT NULL DEFAULT '{}',
    mutates_state TEXT[] NOT NULL DEFAULT '{}',
    requires_auth TEXT[] NOT NULL DEFAULT '{}',
    throws_errors TEXT[] NOT NULL DEFAULT '{}',
    -- Provenance
    source VARCHAR(50) NOT NULL DEFAULT 'static_analysis', -- 'static_analysis', 'runtime_observed', 'merged'
    confidence FLOAT NOT NULL DEFAULT 0.8,
    UNIQUE (symbol_version_id, source)
);

CREATE INDEX idx_effects_sv ON effect_signatures(symbol_version_id);
CREATE INDEX idx_effects_class ON effect_signatures(effect_class);
CREATE INDEX idx_effects_resources ON effect_signatures USING gin(reads_resources);
CREATE INDEX idx_effects_writes ON effect_signatures USING gin(writes_resources);

-- ============================================================================
-- 4. CONCEPT FAMILIES — clustered homolog groups
-- ============================================================================

CREATE TABLE concept_families (
    family_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Family identity
    family_name VARCHAR(255) NOT NULL,
    family_type VARCHAR(50) NOT NULL, -- 'validator', 'serializer', 'auth_policy', 'normalization', 'billing_rule', 'feature_gate', 'error_handler', 'query_builder', 'business_rule', 'custom'
    -- Canonical exemplar — the most representative member
    exemplar_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE SET NULL,
    -- Family-level fingerprints
    family_contract_fingerprint TEXT,
    family_effect_fingerprint TEXT,
    -- Statistics
    member_count INT NOT NULL DEFAULT 0,
    avg_confidence FLOAT NOT NULL DEFAULT 0.0,
    contradiction_count INT NOT NULL DEFAULT 0,
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, snapshot_id, family_name)
);

CREATE INDEX idx_families_repo ON concept_families(repo_id, snapshot_id);
CREATE INDEX idx_families_type ON concept_families(family_type);

CREATE TABLE concept_family_members (
    member_id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES concept_families(family_id) ON DELETE CASCADE,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Member role
    is_exemplar BOOLEAN NOT NULL DEFAULT FALSE,
    is_outlier BOOLEAN NOT NULL DEFAULT FALSE,
    is_contradicting BOOLEAN NOT NULL DEFAULT FALSE,
    -- Similarity to family
    similarity_to_exemplar FLOAT NOT NULL DEFAULT 0.0,
    -- Evidence
    membership_confidence FLOAT NOT NULL DEFAULT 0.0,
    contradiction_flags TEXT[] NOT NULL DEFAULT '{}',
    -- Deviation from family contract/effect
    contract_deviation TEXT,
    effect_deviation TEXT,
    UNIQUE (family_id, symbol_version_id)
);

CREATE INDEX idx_family_members_family ON concept_family_members(family_id);
CREATE INDEX idx_family_members_sv ON concept_family_members(symbol_version_id);

-- ============================================================================
-- 5. TEMPORAL INTELLIGENCE — git history mining
-- ============================================================================

CREATE TABLE temporal_co_changes (
    co_change_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    -- The two symbols that co-change
    symbol_a_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    symbol_b_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    -- Statistics
    co_change_count INT NOT NULL DEFAULT 0,
    total_changes_a INT NOT NULL DEFAULT 0,
    total_changes_b INT NOT NULL DEFAULT 0,
    -- Jaccard: co_change_count / (total_changes_a + total_changes_b - co_change_count)
    jaccard_coefficient FLOAT NOT NULL DEFAULT 0.0,
    -- Temporal window
    first_co_change TIMESTAMP WITH TIME ZONE,
    last_co_change TIMESTAMP WITH TIME ZONE,
    -- Metadata
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, symbol_a_id, symbol_b_id)
);

CREATE INDEX idx_cochange_repo ON temporal_co_changes(repo_id);
CREATE INDEX idx_cochange_a ON temporal_co_changes(symbol_a_id);
CREATE INDEX idx_cochange_b ON temporal_co_changes(symbol_b_id);
CREATE INDEX idx_cochange_jaccard ON temporal_co_changes(jaccard_coefficient DESC);

CREATE TABLE temporal_risk_scores (
    risk_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    symbol_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Risk dimensions
    change_frequency INT NOT NULL DEFAULT 0,         -- total commits touching this symbol
    bug_fix_count INT NOT NULL DEFAULT 0,            -- commits with fix/bug in message
    regression_count INT NOT NULL DEFAULT 0,          -- reverts or re-fixes
    recent_churn_30d INT NOT NULL DEFAULT 0,          -- changes in last 30 days
    distinct_authors INT NOT NULL DEFAULT 0,          -- number of different authors
    -- Composite risk score (0.0 = safe, 1.0 = very risky)
    composite_risk FLOAT NOT NULL DEFAULT 0.0,
    -- Temporal
    last_change_date TIMESTAMP WITH TIME ZONE,
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, symbol_id, snapshot_id)
);

CREATE INDEX idx_risk_repo ON temporal_risk_scores(repo_id, snapshot_id);
CREATE INDEX idx_risk_symbol ON temporal_risk_scores(symbol_id);
CREATE INDEX idx_risk_composite ON temporal_risk_scores(composite_risk DESC);

-- ============================================================================
-- 6. RUNTIME EVIDENCE — trace ingestion and dynamic edges
-- ============================================================================

CREATE TABLE runtime_traces (
    trace_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Trace metadata
    trace_source VARCHAR(50) NOT NULL, -- 'test_execution', 'dev_run', 'ci_trace', 'production_sample'
    trace_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Raw trace data
    call_edges JSONB NOT NULL DEFAULT '[]',   -- [{caller_key, callee_key, receiver_type, count}]
    dynamic_routes JSONB NOT NULL DEFAULT '[]', -- [{route, handler_key, method}]
    observed_types JSONB NOT NULL DEFAULT '[]', -- [{expression, observed_type, location}]
    framework_events JSONB NOT NULL DEFAULT '[]', -- [{event_type, detail}]
    -- Processing state
    is_processed BOOLEAN NOT NULL DEFAULT FALSE,
    edges_resolved INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_traces_repo ON runtime_traces(repo_id, snapshot_id);
CREATE INDEX idx_traces_unprocessed ON runtime_traces(is_processed) WHERE is_processed = FALSE;

CREATE TABLE runtime_observed_edges (
    observed_edge_id UUID PRIMARY KEY,
    trace_id UUID NOT NULL REFERENCES runtime_traces(trace_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- The observed call
    caller_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    callee_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Dynamic dispatch info
    receiver_type TEXT,
    call_count INT NOT NULL DEFAULT 1,
    -- Confidence (higher for more observations)
    confidence FLOAT NOT NULL DEFAULT 0.9,
    first_observed TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_observed TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_observed_caller ON runtime_observed_edges(caller_symbol_version_id);
CREATE INDEX idx_observed_callee ON runtime_observed_edges(callee_symbol_version_id);
CREATE INDEX idx_observed_snapshot ON runtime_observed_edges(snapshot_id);

-- ============================================================================
-- 7. ENHANCED PROVENANCE — upgrade existing relations
-- ============================================================================

-- Add provenance to structural relations
ALTER TABLE structural_relations ADD COLUMN IF NOT EXISTS provenance VARCHAR(50) NOT NULL DEFAULT 'static_exact';
-- Values: 'static_exact', 'static_inferred', 'runtime_observed', 'framework_declared', 'developer_asserted'

-- Add provenance to inferred relations
ALTER TABLE inferred_relations ADD COLUMN IF NOT EXISTS provenance VARCHAR(50) NOT NULL DEFAULT 'static_inferred';

-- Add lineage tracking to symbol_versions
ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS normalized_ast_hash VARCHAR(64);
-- (already exists in some versions, IF NOT EXISTS handles idempotency)

-- ============================================================================
-- 8. CAPSULE METADATA — inclusion rationale tracking
-- ============================================================================

CREATE TABLE capsule_compilations (
    capsule_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Configuration
    mode VARCHAR(20) NOT NULL,
    token_budget INT NOT NULL,
    -- Results
    token_estimate INT NOT NULL,
    nodes_included INT NOT NULL,
    nodes_omitted INT NOT NULL,
    -- Rationale (for debugging and improvement)
    inclusion_rationale JSONB NOT NULL DEFAULT '[]',
    exclusion_rationale JSONB NOT NULL DEFAULT '[]',
    -- Fetch handles for omitted nodes
    omitted_handles JSONB NOT NULL DEFAULT '[]',
    compiled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_capsule_sv ON capsule_compilations(symbol_version_id);
CREATE INDEX idx_capsule_snapshot ON capsule_compilations(snapshot_id);

-- ============================================================================
-- 9. REPOSITORIES ENHANCEMENT
-- ============================================================================

-- base_path already added by migration 002 (IF NOT EXISTS is idempotent)
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS base_path TEXT;

-- ============================================================================
-- 10. VALIDATION REPORT STORAGE
-- ============================================================================
-- NOTE: validation_report_ref and propagation_report_ref were already converted
-- from VARCHAR(255) to JSONB in migration 002. The ALTER below is a no-op on
-- an already-JSONB column but kept for idempotency on fresh installs where
-- migration 002 might not have run (e.g., direct schema load).
-- Using DO block to avoid error if column is already JSONB.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'change_transactions'
          AND column_name = 'validation_report_ref'
          AND data_type != 'jsonb'
    ) THEN
        ALTER TABLE change_transactions
            ALTER COLUMN validation_report_ref TYPE JSONB USING validation_report_ref::jsonb,
            ALTER COLUMN propagation_report_ref TYPE JSONB USING propagation_report_ref::jsonb;
    END IF;
END $$;

-- >>> 008_bugfixes.sql

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

-- >>> 009_repository_identity.sql

ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_base_path_unique
    ON repositories(base_path)
    WHERE base_path IS NOT NULL;

-- >>> 010_performance_indexes.sql

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

-- >>> 011_schema_constraints.sql

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

-- >>> 012_fix_constraints.sql

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

-- >>> 013_index_cleanup_and_integrity.sql

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

-- >>> 014_retention_and_lifecycle.sql

-- Migration 014: Retention policy support and lifecycle management
--
-- 1. Add retained_until column to snapshots for policy-based expiry
-- 2. Create cleanup_log table for retention audit trail
-- 3. Add index on snapshots(repo_id, created_at) for efficient age-based queries
-- 4. Add index on change_transactions(state, updated_at) for stale cleanup

-- ─── Snapshot Retention Column ────────────────────────────────────────────────
-- NULL means "retain indefinitely" (default). When a retention policy runs,
-- it stamps retained_until with the computed expiry timestamp. Snapshots
-- past their retained_until are eligible for cleanup on the next cycle.

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

-- >>> 015_temporal_and_retention_indexes.sql

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

CREATE INDEX IF NOT EXISTS idx_temporal_co_changes_created_brin
    ON temporal_co_changes USING brin (created_at)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_temporal_risk_scores_created_brin
    ON temporal_risk_scores USING brin (created_at)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_runtime_observed_edges_created_brin
    ON runtime_observed_edges USING brin (created_at)
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
