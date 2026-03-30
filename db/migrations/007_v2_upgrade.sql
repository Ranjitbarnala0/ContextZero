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
