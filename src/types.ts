/**
 * ContextZero — Canonical Type Definitions
 *
 * Shared TypeScript interfaces and enums for all entities in the system.
 * Every engine, adapter, and API endpoint imports types from here.
 */

// ENUMS

export type SymbolKind =
    | 'function' | 'method' | 'class' | 'interface'
    | 'route_handler' | 'validator' | 'serializer'
    | 'query_builder' | 'schema_object' | 'test_case'
    | 'config_object' | 'variable' | 'type_alias' | 'enum' | 'module';

export type Visibility = 'public' | 'private' | 'protected' | 'internal' | 'package';

export type StructuralRelationType =
    | 'calls' | 'called_by'
    | 'references' | 'defines'
    | 'imports' | 'exports'
    | 'implements' | 'inherits'
    | 'typed_as' | 'overrides';

export type InferredRelationType =
    | 'validator_homolog' | 'serializer_homolog'
    | 'auth_policy_peer' | 'near_duplicate_logic'
    | 'business_rule_parallel' | 'normalization_homolog'
    | 'contract_sibling' | 'co_changed_with'
    | 'query_logic_duplicate' | 'error_mapping_peer';

export type PurityClass = 'pure' | 'read_only' | 'read_write' | 'side_effecting';

export type TransactionState =
    | 'planned' | 'prepared' | 'patched' | 'reindexed'
    | 'validated' | 'propagation_pending'
    | 'committed' | 'rolled_back' | 'failed';

export type IndexStatus = 'pending' | 'indexing' | 'complete' | 'failed' | 'partial';
export type ValidationMode = 'quick' | 'standard' | 'strict';
export type CapsuleMode = 'minimal' | 'standard' | 'strict';
export type RelationSource = 'static_analysis' | 'runtime_trace' | 'heuristic' | 'manual';
export type RelationProvenance = 'static_exact' | 'static_inferred' | 'runtime_observed' | 'framework_declared' | 'developer_asserted';
export type InvariantSourceType = 'explicit_test' | 'derived' | 'manual' | 'assertion' | 'schema' | 'guard_clause' | 'type_constraint' | 'pattern' | 'cross_symbol';
export type EffectClass = 'pure' | 'reader' | 'writer' | 'io' | 'full_side_effect';
export type DispatchResolutionMethod = 'type_annotation' | 'constructor_assignment' | 'field_inference' | 'inheritance_mro' | 'runtime_observed' | 'unresolved';
export type TraceSource = 'test_execution' | 'dev_run' | 'ci_trace' | 'production_sample';
export type ConceptFamilyType = 'validator' | 'serializer' | 'auth_policy' | 'normalization' | 'billing_rule' | 'feature_gate' | 'error_handler' | 'query_builder' | 'business_rule' | 'custom';
export type ContextResolution = 'full_source' | 'signature_only' | 'contract_summary' | 'effect_summary' | 'name_only';
export type InvariantScopeLevel = 'global' | 'module' | 'symbol';

// CONFIDENCE BANDS

export type ConfidenceBand = 'high' | 'medium' | 'low';

export function classifyConfidenceBand(confidence: number): ConfidenceBand {
    if (confidence >= 0.80) return 'high';
    if (confidence >= 0.50) return 'medium';
    return 'low';
}

// REVIEW STATE

export type ReviewState = 'pending' | 'confirmed' | 'rejected' | 'flagged';

// DATABASE ENTITIES

export interface IndexedFile {
    file_id: string;
    snapshot_id: string;
    path: string;
    content_hash: string;
    language: string;
    parse_status: 'success' | 'partial' | 'failed';
}

export interface TestArtifact {
    test_artifact_id: string;
    symbol_version_id: string;
    framework: string;
    related_symbols: string[];
    assertion_summary: string;
    coverage_hints: string[];
}

export interface Repository {
    repo_id: string;
    name: string;
    default_branch: string;
    visibility: 'public' | 'private';
    language_set: string[];
    base_path: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface Snapshot {
    snapshot_id: string;
    repo_id: string;
    commit_sha: string;
    branch: string;
    parent_snapshot_id: string | null;
    indexed_at: Date;
    index_status: IndexStatus;
}

export interface SymbolVersion {
    symbol_version_id: string;
    symbol_id: string;
    snapshot_id: string;
    file_id: string;
    range_start_line: number;
    range_start_col: number;
    range_end_line: number;
    range_end_col: number;
    signature: string;
    ast_hash: string;
    body_hash: string;
    summary: string;
    body_source: string | null;
    visibility: Visibility;
    language: string;
    uncertainty_flags: string[];
}

export interface StructuralRelation {
    relation_id: string;
    src_symbol_version_id: string;
    dst_symbol_version_id: string;
    relation_type: StructuralRelationType;
    strength: number;
    source: RelationSource;
    confidence: number;
    provenance?: RelationProvenance;
}

export interface BehavioralProfile {
    behavior_profile_id: string;
    symbol_version_id: string;
    purity_class: PurityClass;
    resource_touches: string[];
    db_reads: string[];
    db_writes: string[];
    network_calls: string[];
    cache_ops: string[];
    file_io: string[];
    auth_operations: string[];
    validation_operations: string[];
    exception_profile: string[];
    state_mutation_profile: string[];
    transaction_profile: string[];
}

export interface ContractProfile {
    contract_profile_id: string;
    symbol_version_id: string;
    input_contract: string;
    output_contract: string;
    error_contract: string;
    schema_refs: string[];
    api_contract_refs: string[];
    serialization_contract: string;
    security_contract: string;
    derived_invariants_count: number;
}

export interface Invariant {
    invariant_id: string;
    repo_id: string;
    scope_symbol_id: string | null;
    scope_level: InvariantScopeLevel;
    expression: string;
    source_type: InvariantSourceType;
    strength: number;
    validation_method: string;
    last_verified_snapshot_id: string | null;
}

export interface ChangeTransaction {
    txn_id: string;
    repo_id: string;
    base_snapshot_id: string;
    created_by: string;
    state: TransactionState;
    target_symbol_versions: string[];
    patches: PatchSet;
    impact_report_ref: string | null;
    validation_report_ref: ValidationReport | null;
    propagation_report_ref: PropagationCandidate[] | null;
    created_at: Date;
    updated_at: Date;
}

export interface TransactionRecoverySummary {
    scanned: number;
    recovered: number;
    recovery_failed: number;
    cleaned_terminal_backups: number;
}

// ENGINE OUTPUT TYPES

export interface PatchEntry {
    file_path: string;
    new_content: string;
}

export type PatchSet = PatchEntry[];

export interface BlastRadiusImpact {
    symbol_id: string;
    symbol_name: string;
    file_path: string | null;
    start_line: number | null;
    end_line: number | null;
    impact_type: 'structural' | 'behavioral' | 'contract' | 'homolog' | 'historical';
    relation_type: string;
    confidence: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    evidence: string;
    recommended_action: 'propagation' | 'manual_review' | 'rerun_test' | 'validate_contract' | 'no_action';
}

export interface BlastRadiusReport {
    target_symbols: string[];
    structural_impacts: BlastRadiusImpact[];
    behavioral_impacts: BlastRadiusImpact[];
    contract_impacts: BlastRadiusImpact[];
    homolog_impacts: BlastRadiusImpact[];
    historical_impacts: BlastRadiusImpact[];
    total_impact_count: number;
    recommended_validation_scope: ValidationMode;
}

export interface ContextCapsule {
    target_symbol: {
        symbol_id: string;
        name: string;
        code: string;
        signature: string;
        location: { file_path: string; start_line: number; end_line: number };
    };
    context_nodes: ContextNode[];
    omission_rationale: string[];
    uncertainty_notes: string[];
    token_estimate: number;
    // V2 additions
    fetch_handles?: FetchHandle[];
    dispatch_context?: DispatchContextNode[];
    family_context?: FamilyContextNode[];
    effect_signature?: EffectEntry[];
    inclusion_rationale?: InclusionRationale[];
    compilation_id?: string;
}

export interface ContextNode {
    type: 'dependency' | 'caller' | 'test' | 'contract' | 'invariant'
        | 'homolog' | 'type_context' | 'related_change'
        | 'dispatch_target' | 'family_member' | 'effect';
    symbol_id: string | null;
    name: string;
    code: string | null;
    summary: string | null;
    relevance: number;
    // V2 additions
    resolution?: ContextResolution;
    inclusion_reason?: string;
    effect_signature?: string;
}

export interface HomologCandidate {
    symbol_id: string;
    symbol_version_id: string;
    symbol_name: string;
    relation_type: InferredRelationType;
    confidence: number;
    evidence: EvidenceScores;
    contradiction_flags: string[];
}

export interface EvidenceScores {
    semantic_intent_similarity: number;
    normalized_logic_similarity: number;
    signature_type_similarity: number;
    behavioral_overlap: number;
    contract_overlap: number;
    test_overlap: number;
    history_co_change: number;
    weighted_total: number;
    evidence_family_count: number;
    rationale: string;
}

export interface ValidationReport {
    transaction_id: string;
    mode: ValidationMode;
    overall_passed: boolean;
    validation_snapshot_id?: string;
    levels: {
        level: number;
        name: string;
        passed: boolean;
        details: string;
        failures: string[];
    }[];
    executed_at: Date;
}

export interface PropagationCandidate {
    homolog_symbol_id: string;
    homolog_name: string;
    relation_type: InferredRelationType;
    confidence: number;
    is_safe: boolean;
    patch_proposal: PatchEntry | null;
    risk_notes: string[];
}

export interface UncertaintyAnnotation {
    source: string;
    affected_symbol_id: string | null;
    description: string;
    confidence_impact: number;
    recommended_evidence: string;
}

// ADAPTER OUTPUT TYPES

export interface ExtractedSymbol {
    stable_key: string;
    canonical_name: string;
    kind: string;
    range_start_line: number;
    range_start_col: number;
    range_end_line: number;
    range_end_col: number;
    signature: string;
    ast_hash: string;
    body_hash: string;
    normalized_ast_hash?: string;
    summary?: string;
    visibility: string;
}

export interface ExtractedRelation {
    source_key: string;
    target_name: string;
    relation_type: StructuralRelationType;
}

export interface BehaviorHint {
    symbol_key: string;
    hint_type: 'db_read' | 'db_write' | 'network_call' | 'file_io' | 'cache_op'
             | 'auth_check' | 'validation' | 'throws' | 'catches' | 'state_mutation'
             | 'transaction' | 'logging' | 'acquires_lock' | 'serialization'
             | 'concurrency' | 'cache_write';
    detail: string;
    line: number;
}

export interface ContractHint {
    symbol_key: string;
    input_types: string[];
    output_type: string;
    thrown_types: string[];
    decorators: string[];
}

export interface AdapterExtractionResult {
    symbols: ExtractedSymbol[];
    relations: ExtractedRelation[];
    behavior_hints: BehaviorHint[];
    contract_hints: ContractHint[];
    parse_confidence: number;
    uncertainty_flags: string[];
}

export interface IngestionResult {
    repo_id: string;
    snapshot_id: string;
    files_processed: number;
    files_failed: number;
    symbols_extracted: number;
    relations_extracted: number;
    behavior_hints_extracted: number;
    contract_hints_extracted: number;
    duration_ms: number;
    // V2 additions
    dispatch_edges_resolved?: number;
    lineages_computed?: number;
    effect_signatures_computed?: number;
    deep_contracts_mined?: number;
    concept_families_built?: number;
    temporal_co_changes_found?: number;
}

// ============================================================================
// V2 ENTITIES — Dispatch, Lineage, Effects, Families, Temporal, Runtime
// ============================================================================

// SYMBOL LINEAGE

export interface SymbolLineage {
    lineage_id: string;
    repo_id: string;
    identity_seed: string;
    canonical_name: string;
    kind: string;
    language: string;
    birth_snapshot_id: string | null;
    death_snapshot_id: string | null;
    previous_lineage_id: string | null;
    rename_confidence: number | null;
    is_alive: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface LineageResult {
    total_symbols: number;
    new_lineages: number;
    matched_lineages: number;
    renamed_lineages: number;
    dead_lineages: number;
}

export interface RenameMatch {
    old_lineage_id: string;
    new_symbol_id: string;
    old_name: string;
    new_name: string;
    confidence: number;
    match_method: string;
}

// DISPATCH RESOLUTION

export interface DispatchEdge {
    dispatch_edge_id: string;
    snapshot_id: string;
    caller_symbol_version_id: string;
    receiver_expression: string;
    receiver_types: string[];
    resolved_symbol_version_ids: string[];
    resolution_method: DispatchResolutionMethod;
    confidence: number;
    is_polymorphic: boolean;
    class_hierarchy_depth: number | null;
    override_chain: string[] | null;
}

export interface DispatchResolution {
    resolved: boolean;
    target_symbol_version_ids: string[];
    receiver_type: string | null;
    resolution_method: DispatchResolutionMethod;
    confidence: number;
    is_polymorphic: boolean;
    chain_segments: { expression: string; resolved_type: string | null }[];
}

export interface ClassHierarchyEntry {
    hierarchy_id: string;
    snapshot_id: string;
    class_symbol_version_id: string;
    parent_symbol_version_id: string | null;
    mro_position: number;
    relation_kind: 'extends' | 'implements' | 'mixin' | 'protocol';
}

// EFFECT SIGNATURES

export interface EffectEntry {
    kind: 'reads' | 'writes' | 'emits' | 'calls_external' | 'mutates'
        | 'requires' | 'throws' | 'opens' | 'normalizes' | 'acquires_lock' | 'logs';
    /** Domain key — resource path, event name, error type, etc. */
    descriptor: string;
    detail: string;
    /** Whether this effect was observed directly or propagated from a callee */
    provenance?: 'direct' | 'transitive';
    /** @deprecated Use `descriptor` — kept for backwards compatibility in API responses */
    resource?: string;
}

export interface EffectSignature {
    effect_signature_id: string;
    symbol_version_id: string;
    effects: EffectEntry[];
    effect_class: EffectClass;
    reads_resources: string[];
    writes_resources: string[];
    emits_events: string[];
    calls_external: string[];
    mutates_state: string[];
    requires_auth: string[];
    throws_errors: string[];
    source: string;
    confidence: number;
}

export interface EffectDiff {
    added_effects: EffectEntry[];
    removed_effects: EffectEntry[];
    changed_class: { before: EffectClass; after: EffectClass } | null;
    escalated: boolean;
    new_resources: string[];
    removed_resources: string[];
}

// CONCEPT FAMILIES

export interface ConceptFamily {
    family_id: string;
    repo_id: string;
    snapshot_id: string;
    family_name: string;
    family_type: ConceptFamilyType;
    exemplar_symbol_version_id: string | null;
    family_contract_fingerprint: string | null;
    family_effect_fingerprint: string | null;
    member_count: number;
    avg_confidence: number;
    contradiction_count: number;
}

export interface ConceptFamilyMember {
    member_id: string;
    family_id: string;
    symbol_version_id: string;
    is_exemplar: boolean;
    is_outlier: boolean;
    is_contradicting: boolean;
    similarity_to_exemplar: number;
    membership_confidence: number;
    contradiction_flags: string[];
    contract_deviation: string | null;
    effect_deviation: string | null;
}

export interface FamilyBuildResult {
    families_created: number;
    total_members: number;
    outliers_detected: number;
    contradictions_detected: number;
}

// TEMPORAL INTELLIGENCE

export interface TemporalRiskScore {
    risk_id: string;
    repo_id: string;
    symbol_id: string;
    snapshot_id: string;
    change_frequency: number;
    bug_fix_count: number;
    regression_count: number;
    recent_churn_30d: number;
    distinct_authors: number;
    composite_risk: number;
    last_change_date: Date | null;
}

export interface CoChangePartner {
    symbol_id: string;
    canonical_name: string;
    co_change_count: number;
    jaccard_coefficient: number;
}

export interface TemporalResult {
    commits_analyzed: number;
    co_change_pairs: number;
    risk_scores_computed: number;
}

export interface GitCommit {
    sha: string;
    author: string;
    email: string;
    date: Date;
    message: string;
    files: string[];
}

// RUNTIME EVIDENCE

export interface TracePack {
    source: TraceSource;
    timestamp: Date;
    call_edges: TraceCallEdge[];
    dynamic_routes: TraceDynamicRoute[];
    observed_types: TraceObservedType[];
    framework_events: TraceFrameworkEvent[];
}

export interface TraceCallEdge {
    caller_key: string;
    callee_key: string;
    receiver_type?: string;
    call_count: number;
}

export interface TraceDynamicRoute {
    route: string;
    handler_key: string;
    method: string;
    middleware?: string[];
}

export interface TraceObservedType {
    expression: string;
    observed_type: string;
    location?: string;
}

export interface TraceFrameworkEvent {
    event_type: string;
    detail: Record<string, unknown>;
}

export interface TraceIngestionResult {
    trace_id: string;
    edges_resolved: number;
    types_resolved: number;
    routes_resolved: number;
    uncertainties_reduced: number;
}

export interface RuntimeEvidence {
    observed_call_edges: { callee_name: string; call_count: number; receiver_type: string | null }[];
    observed_as_callee: { caller_name: string; call_count: number }[];
    total_observations: number;
    confidence_boost: number;
}

// ENHANCED CONTEXT CAPSULE V2

export interface FetchHandle {
    symbol_id: string;
    symbol_version_id: string;
    name: string;
    file_path: string;
    start_line: number;
    end_line: number;
    why_omitted: string;
    estimated_tokens: number;
}

export interface DispatchContextNode {
    chain: string;
    resolved_target: string | null;
    target_signature: string | null;
    resolution_method: string;
    confidence: number;
}

export interface FamilyContextNode {
    family_name: string;
    family_type: string;
    exemplar_name: string | null;
    exemplar_signature: string | null;
    member_count: number;
    is_target_exemplar: boolean;
    contradicting_members: string[];
}

export interface InclusionRationale {
    node_name: string;
    node_type: string;
    included: boolean;
    resolution: ContextResolution;
    reason: string;
    tokens_used: number;
    tokens_saved: number;
}

// CONSTANTS

export const HOMOLOG_WEIGHTS = {
    semantic_intent_similarity: 0.20,
    normalized_logic_similarity: 0.20,
    signature_type_similarity: 0.15,
    behavioral_overlap: 0.15,
    contract_overlap: 0.15,
    test_overlap: 0.10,
    history_co_change: 0.05,
} as const;

export const MIN_EVIDENCE_FAMILIES = 2;
export const DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD = 0.60;

// ERROR TYPES

/**
 * Errors that are safe to expose to API consumers.
 * These bypass the error sanitization in safeTool/safeHandler.
 */
export class UserFacingError extends Error {
    public readonly statusCode: number;

    constructor(message: string, statusCode: number = 422) {
        super(message);
        this.name = 'UserFacingError';
        this.statusCode = statusCode;
    }

    static notFound(resource: string): UserFacingError {
        return new UserFacingError(`${resource} not found`, 404);
    }

    static forbidden(message: string): UserFacingError {
        return new UserFacingError(message, 403);
    }

    static badRequest(message: string): UserFacingError {
        return new UserFacingError(message, 400);
    }
}

// Express Request type extension for correlation IDs
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            correlationId?: string;
        }
    }
}
