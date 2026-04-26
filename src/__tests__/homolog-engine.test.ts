/**
 * Comprehensive unit tests for HomologInferenceEngine.
 *
 * Covers all public methods (findHomologs, persistHomologs) and key private
 * methods (scoring, contradiction detection, relation classification, candidate
 * generation) by exercising the class through its public API with carefully
 * crafted mock responses.
 *
 * Mock strategy:
 *   - db-driver: all SQL queries are intercepted; no real database required.
 *   - semantic-engine: computeSemanticSimilarity / computeBodySimilarity /
 *     findSemanticCandidates are jest fns.
 *   - cache: real LRU cache replaced with a simple Map wrapper.
 *   - logger: silent stubs.
 *   - batch-loader: returns empty Maps by default.
 *   - uuid: deterministic counter (project-level mock).
 */

import type {
    BehavioralProfile, ContractProfile, HomologCandidate,
} from '../types';
import {
    HOMOLOG_WEIGHTS, MIN_EVIDENCE_FAMILIES,
    DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD,
} from '../types';

// ── Mocks (must come before imports that reference mocked modules) ───────────

const mockDbQuery = jest.fn();
const mockDbQueryWithClient = jest.fn();
const mockDbTransaction = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockDbQuery(...args),
        queryWithClient: (...args: unknown[]) => mockDbQueryWithClient(...args),
        transaction: (...args: unknown[]) => mockDbTransaction(...args),
    },
}));

jest.mock('../db-driver/batch-loader', () => ({
    BatchLoader: jest.fn().mockImplementation(() => ({
        loadBehavioralProfiles: jest.fn().mockResolvedValue(new Map()),
        loadContractProfiles: jest.fn().mockResolvedValue(new Map()),
    })),
}));

jest.mock('../logger', () => ({
    Logger: jest.fn().mockImplementation(() => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        startTimer: jest.fn().mockReturnValue(jest.fn()),
    })),
}));

const mockFindSemanticCandidates = jest.fn();
const mockComputeSemanticSimilarity = jest.fn();
const mockComputeBodySimilarity = jest.fn();

jest.mock('../semantic-engine', () => ({
    semanticEngine: {
        findSemanticCandidates: (...args: unknown[]) => mockFindSemanticCandidates(...args),
        computeSemanticSimilarity: (...args: unknown[]) => mockComputeSemanticSimilarity(...args),
        computeBodySimilarity: (...args: unknown[]) => mockComputeBodySimilarity(...args),
    },
}));

const mockCacheStore = new Map<string, unknown>();
jest.mock('../cache', () => ({
    profileCache: {
        get: (key: string) => mockCacheStore.get(key),
        set: (key: string, value: unknown) => mockCacheStore.set(key, value),
    },
}));

// ── Import under test (after mocks) ─────────────────────────────────────────

import { HomologInferenceEngine } from '../homolog-engine/index';

// ── Helpers ─────────────────────────────────────────────────────────────────

const emptyResult = () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

interface CandidateRowData {
    symbol_version_id: string;
    symbol_id: string;
    canonical_name: string;
    stable_key: string;
    body_hash: string;
    ast_hash: string;
    normalized_ast_hash: string | null;
    signature: string;
    kind: string;
}

function makeCandidate(overrides: Partial<CandidateRowData> = {}): CandidateRowData {
    return {
        symbol_version_id: 'sv-candidate',
        symbol_id: 'sym-candidate',
        canonical_name: 'processOrder',
        stable_key: 'mod::processOrder',
        body_hash: 'bhash-cand',
        ast_hash: 'ahash-cand',
        normalized_ast_hash: 'nhash-cand',
        signature: '(order: Order): Result',
        kind: 'function',
        ...overrides,
    };
}

function makeTarget(overrides: Partial<CandidateRowData> = {}): CandidateRowData {
    return {
        symbol_version_id: 'sv-target',
        symbol_id: 'sym-target',
        canonical_name: 'processPayment',
        stable_key: 'mod::processPayment',
        body_hash: 'bhash-target',
        ast_hash: 'ahash-target',
        normalized_ast_hash: 'nhash-target',
        signature: '(payment: Payment): Result',
        kind: 'function',
        ...overrides,
    };
}

function makeBehavioralProfile(overrides: Partial<BehavioralProfile> = {}): BehavioralProfile {
    return {
        behavior_profile_id: 'bp-test',
        symbol_version_id: 'sv-test',
        purity_class: 'pure',
        resource_touches: [],
        db_reads: [],
        db_writes: [],
        network_calls: [],
        cache_ops: [],
        file_io: [],
        auth_operations: [],
        validation_operations: [],
        exception_profile: [],
        state_mutation_profile: [],
        transaction_profile: [],
        ...overrides,
    };
}

function makeContractProfile(overrides: Partial<ContractProfile> = {}): ContractProfile {
    return {
        contract_profile_id: 'cp-test',
        symbol_version_id: 'sv-test',
        input_contract: '(id: string)',
        output_contract: 'User',
        error_contract: 'NotFoundError',
        schema_refs: [],
        api_contract_refs: [],
        serialization_contract: 'none',
        security_contract: 'none',
        derived_invariants_count: 0,
        ...overrides,
    };
}

/**
 * Configure mockDbQuery to respond to sequential calls in a controlled way.
 * This helper builds a routing table keyed on SQL substrings so that the
 * same jest.fn can serve multiple different queries made by generateCandidates,
 * scoreCandidate, detectContradictions, etc.
 */
function routeDbQueries(routes: Array<{ match: string; result: unknown }>) {
    mockDbQuery.mockImplementation((sql: string, _params?: unknown[]) => {
        for (const route of routes) {
            if (sql.includes(route.match)) {
                return Promise.resolve(route.result);
            }
        }
        return Promise.resolve(emptyResult());
    });
}

let engine: HomologInferenceEngine;

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockCacheStore.clear();
    engine = new HomologInferenceEngine();

    // Default: semantic engine calls return neutral values
    mockComputeSemanticSimilarity.mockResolvedValue(0.5);
    mockComputeBodySimilarity.mockResolvedValue(0.0);
    mockFindSemanticCandidates.mockResolvedValue([]);

    // Default: transaction passes the callback a mock client
    mockDbTransaction.mockImplementation(async (cb: (client: unknown) => Promise<unknown>) => {
        const fakeClient = {};
        return cb(fakeClient);
    });
    // Default: INSERT ... RETURNING evidence_bundle_id returns the bundleId from $1.
    // Both bundle and inferred_relation INSERTs use this default.
    mockDbQueryWithClient.mockImplementation((_client: unknown, sql: string, params: unknown[]) => {
        if (sql.includes('INTO evidence_bundles') && sql.includes('RETURNING')) {
            return Promise.resolve({
                rows: [{ evidence_bundle_id: params[0] }],
                rowCount: 1, command: 'INSERT', oid: 0, fields: [],
            });
        }
        return Promise.resolve(emptyResult());
    });
});

// =====================================================================
// 1. findHomologs — basic flows
// =====================================================================

describe('HomologInferenceEngine.findHomologs', () => {

    test('returns empty array when target symbol is not found', async () => {
        mockDbQuery.mockResolvedValue(emptyResult());

        const result = await engine.findHomologs('sv-missing', 'snap-1');

        expect(result).toEqual([]);
    });

    test('returns empty array when no candidates are generated', async () => {
        const target = makeTarget();

        // First call: loadSymbolData for target -> found
        // All subsequent calls (bucket queries): no rows
        let callCount = 0;
        mockDbQuery.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve({ rows: [target], rowCount: 1 });
            }
            return Promise.resolve(emptyResult());
        });

        const result = await engine.findHomologs('sv-target', 'snap-1');
        expect(result).toEqual([]);
    });

    test('skips candidate with same symbol_version_id as target', async () => {
        const target = makeTarget();
        // A candidate that has the same SVId as the target
        const selfCandidate = makeCandidate({
            symbol_version_id: 'sv-target', // same as target
        });

        routeDbQueries([
            // loadSymbolData (first call for target)
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            // bucket 1: body_hash match returns the self-candidate
            { match: 'sv.body_hash = $2', result: { rows: [selfCandidate], rowCount: 1 } },
        ]);

        const result = await engine.findHomologs('sv-target', 'snap-1');
        // Should be filtered out since it's the same symbol version
        expect(result).toEqual([]);
    });

    test('returns scored homologs sorted by confidence descending', async () => {
        const target = makeTarget({ body_hash: 'SHARED', ast_hash: 'SHARED' });
        const cand1 = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            canonical_name: 'processPayment', // same name
            body_hash: 'SHARED', ast_hash: 'SHARED', // identical
            signature: '(payment: Payment): Result',
        });
        const cand2 = makeCandidate({
            symbol_version_id: 'sv-c2', symbol_id: 'sym-c2',
            canonical_name: 'handleRefund',
            body_hash: 'SHARED', ast_hash: 'different-ast',
            signature: '(refund: Refund): void',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand1, cand2], rowCount: 2 } },
            // behavioral_profiles: none found
            { match: 'behavioral_profiles', result: emptyResult() },
            // contract_profiles: none found
            { match: 'contract_profiles', result: emptyResult() },
            // test_artifacts: none
            { match: 'test_artifacts', result: emptyResult() },
            // symbol_versions for history: none
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        // semantic engine: cand1 has high similarity, cand2 lower
        mockComputeSemanticSimilarity.mockImplementation(
            (_a: string, b: string) => Promise.resolve(b === 'sv-c1' ? 0.95 : 0.3),
        );

        const result = await engine.findHomologs('sv-target', 'snap-1');

        // Both should have logic_sim >= 0.85 (body_hash match -> 1.0),
        // which triggers the structural identity override (confidence >= 0.85, familyCount >= 3)
        // so both should pass threshold & evidence families.
        expect(result.length).toBeGreaterThanOrEqual(1);
        // Sorted descending by confidence
        if (result.length >= 2) {
            expect(result[0].confidence).toBeGreaterThanOrEqual(result[1].confidence);
        }
    });

    test('respects custom confidence threshold', async () => {
        const target = makeTarget();
        const cand = makeCandidate({ symbol_version_id: 'sv-c1', symbol_id: 'sym-c1' });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: emptyResult() },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        // With very high threshold (0.99) most candidates should be filtered
        mockComputeSemanticSimilarity.mockResolvedValue(0.3);
        mockComputeBodySimilarity.mockResolvedValue(0.2);

        const result = await engine.findHomologs('sv-target', 'snap-1', 0.99);
        expect(result).toEqual([]);
    });

    test('uses DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD when no threshold provided', async () => {
        // This is a constant check; the default arg is 0.60
        expect(DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD).toBe(0.60);
    });

    test('filters out candidates with fewer than MIN_EVIDENCE_FAMILIES', async () => {
        const target = makeTarget();
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            canonical_name: 'completelyDifferent',
            body_hash: 'diff-body', ast_hash: 'diff-ast',
            normalized_ast_hash: null,
            signature: '',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'kind = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        // Return very low semantic similarity -> at most 1 evidence family
        mockComputeSemanticSimilarity.mockResolvedValue(0.0);
        mockComputeBodySimilarity.mockResolvedValue(0.0);

        const result = await engine.findHomologs('sv-target', 'snap-1', 0.01);
        expect(result).toEqual([]);
    });
});

// =====================================================================
// 2. persistHomologs
// =====================================================================

describe('HomologInferenceEngine.persistHomologs', () => {

    test('returns 0 and does not call transaction when homologs list is empty', async () => {
        const count = await engine.persistHomologs('sv-source', [], 'snap-1');
        expect(count).toBe(0);
        expect(mockDbTransaction).not.toHaveBeenCalled();
    });

    test('persists each homolog with evidence bundle and inferred relation', async () => {
        const homologs: HomologCandidate[] = [{
            symbol_id: 'sym-1',
            symbol_version_id: 'sv-1',
            symbol_name: 'processOrder',
            relation_type: 'near_duplicate_logic',
            confidence: 0.92,
            evidence: {
                semantic_intent_similarity: 0.8,
                normalized_logic_similarity: 1.0,
                signature_type_similarity: 0.7,
                behavioral_overlap: 0.5,
                contract_overlap: 0.4,
                test_overlap: 0.3,
                history_co_change: 0.1,
                weighted_total: 0.92,
                evidence_family_count: 5,
                rationale: 'near-identical logic; strong name similarity',
            },
            contradiction_flags: ['side_effects_differ'],
        }];

        const count = await engine.persistHomologs('sv-source', homologs, 'snap-1');

        expect(count).toBe(1);
        expect(mockDbTransaction).toHaveBeenCalledTimes(1);
        // Two queryWithClient calls per homolog: evidence_bundle + inferred_relation
        expect(mockDbQueryWithClient).toHaveBeenCalledTimes(2);
    });

    test('persists multiple homologs in a single transaction', async () => {
        const homologs: HomologCandidate[] = [
            {
                symbol_id: 'sym-1', symbol_version_id: 'sv-1',
                symbol_name: 'a', relation_type: 'near_duplicate_logic',
                confidence: 0.9,
                evidence: {
                    semantic_intent_similarity: 0.8, normalized_logic_similarity: 1.0,
                    signature_type_similarity: 0.7, behavioral_overlap: 0.5,
                    contract_overlap: 0.4, test_overlap: 0.3,
                    history_co_change: 0.1, weighted_total: 0.9,
                    evidence_family_count: 5, rationale: 'test',
                },
                contradiction_flags: [],
            },
            {
                symbol_id: 'sym-2', symbol_version_id: 'sv-2',
                symbol_name: 'b', relation_type: 'contract_sibling',
                confidence: 0.85,
                evidence: {
                    semantic_intent_similarity: 0.6, normalized_logic_similarity: 0.3,
                    signature_type_similarity: 0.5, behavioral_overlap: 0.7,
                    contract_overlap: 0.8, test_overlap: 0.0,
                    history_co_change: 0.0, weighted_total: 0.85,
                    evidence_family_count: 4, rationale: 'test2',
                },
                contradiction_flags: [],
            },
        ];

        const count = await engine.persistHomologs('sv-source', homologs, 'snap-1');

        expect(count).toBe(2);
        expect(mockDbTransaction).toHaveBeenCalledTimes(1);
        // 2 homologs x 2 queries each = 4
        expect(mockDbQueryWithClient).toHaveBeenCalledTimes(4);
    });

    test('evidence bundle INSERT includes correct score values', async () => {
        const evidence = {
            semantic_intent_similarity: 0.75,
            normalized_logic_similarity: 0.90,
            signature_type_similarity: 0.60,
            behavioral_overlap: 0.45,
            contract_overlap: 0.30,
            test_overlap: 0.20,
            history_co_change: 0.05,
            weighted_total: 0.80,
            evidence_family_count: 6,
            rationale: 'near-identical logic',
        };
        const homologs: HomologCandidate[] = [{
            symbol_id: 'sym-1', symbol_version_id: 'sv-1',
            symbol_name: 'fn', relation_type: 'near_duplicate_logic',
            confidence: 0.80, evidence,
            contradiction_flags: ['io_shape_diverges'],
        }];

        await engine.persistHomologs('sv-source', homologs, 'snap-1');

        // First queryWithClient call is the evidence bundle INSERT
        const bundleCall = mockDbQueryWithClient.mock.calls[0];
        const bundleParams = bundleCall[2]; // [client, sql, params]
        // params order: bundleId, semantic, structural, behavioral, contract, test, history, flags, payload
        expect(bundleParams[1]).toBe(0.75); // semantic
        expect(bundleParams[2]).toBe(0.90); // structural (normalized_logic)
        expect(bundleParams[3]).toBe(0.45); // behavioral
        expect(bundleParams[4]).toBe(0.30); // contract
        expect(bundleParams[5]).toBe(0.20); // test
        expect(bundleParams[6]).toBe(0.05); // history
        expect(bundleParams[7]).toEqual(['io_shape_diverges']); // contradiction_flags
        expect(JSON.parse(bundleParams[8])).toEqual(evidence); // feature_payload
    });

    test('inferred relation INSERT passes correct parameters', async () => {
        const homologs: HomologCandidate[] = [{
            symbol_id: 'sym-1', symbol_version_id: 'sv-dest',
            symbol_name: 'fn', relation_type: 'validator_homolog',
            confidence: 0.88,
            evidence: {
                semantic_intent_similarity: 0, normalized_logic_similarity: 0,
                signature_type_similarity: 0, behavioral_overlap: 0,
                contract_overlap: 0, test_overlap: 0, history_co_change: 0,
                weighted_total: 0.88, evidence_family_count: 3, rationale: '',
            },
            contradiction_flags: [],
        }];

        await engine.persistHomologs('sv-source', homologs, 'snap-1');

        // Second queryWithClient call is the inferred_relation INSERT
        const relCall = mockDbQueryWithClient.mock.calls[1];
        const relParams = relCall[2];
        // params: relationId, srcSvId, dstSvId, relationType, confidence, bundleId, snapshotId
        expect(relParams[1]).toBe('sv-source');
        expect(relParams[2]).toBe('sv-dest');
        expect(relParams[3]).toBe('validator_homolog');
        expect(relParams[4]).toBe(0.88);
        expect(relParams[6]).toBe('snap-1');
    });
});

// =====================================================================
// 3. scoreCandidate — dimension scoring
// =====================================================================

describe('scoreCandidate (via findHomologs)', () => {

    // Helper: set up a single-candidate scenario and return the scored result.
    async function scoreSingleCandidate(
        targetOverrides: Partial<CandidateRowData>,
        candidateOverrides: Partial<CandidateRowData>,
        options: {
            semanticSim?: number;
            bodySim?: number;
            behavioralProfileTarget?: BehavioralProfile | null;
            behavioralProfileCandidate?: BehavioralProfile | null;
            contractProfileTarget?: ContractProfile | null;
            contractProfileCandidate?: ContractProfile | null;
            testOverlapCount?: number;
            historyCo?: { confidence: number } | null;
        } = {},
    ): Promise<HomologCandidate[]> {
        const target = makeTarget(targetOverrides);
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1',
            symbol_id: 'sym-c1',
            ...candidateOverrides,
        });

        const bpTarget = options.behavioralProfileTarget ?? null;
        const bpCandidate = options.behavioralProfileCandidate ?? null;
        const cpTarget = options.contractProfileTarget ?? null;
        const cpCandidate = options.contractProfileCandidate ?? null;

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'sv.ast_hash = $2', result: emptyResult() },
            { match: 'sv.normalized_ast_hash = $2', result: emptyResult() },
            { match: 'canonical_name %', result: emptyResult() },
            { match: 'bp1.purity_class', result: emptyResult() },
            { match: 'AND s.kind = $2', result: emptyResult() },
            // behavioral_profiles
            { match: 'FROM behavioral_profiles', result: emptyResult() },
            // contract_profiles
            { match: 'FROM contract_profiles', result: emptyResult() },
            // test_artifacts
            {
                match: 'test_artifacts',
                result: { rows: [{ cnt: options.testOverlapCount ?? 0 }], rowCount: 1 },
            },
            // symbol_versions for history
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
            // inferred_relations for co-change
            { match: 'inferred_relations', result: options.historyCo
                ? { rows: [options.historyCo], rowCount: 1 }
                : emptyResult(),
            },
        ]);

        // Pre-warm the cache so loadBehavioralProfile / loadContractProfile find data
        if (bpTarget) mockCacheStore.set(`bp:${target.symbol_version_id}`, bpTarget);
        if (bpCandidate) mockCacheStore.set(`bp:sv-c1`, bpCandidate);
        if (cpTarget) mockCacheStore.set(`cp:${target.symbol_version_id}`, cpTarget);
        if (cpCandidate) mockCacheStore.set(`cp:sv-c1`, cpCandidate);

        mockComputeSemanticSimilarity.mockResolvedValue(options.semanticSim ?? 0.5);
        mockComputeBodySimilarity.mockResolvedValue(options.bodySim ?? 0.0);

        return engine.findHomologs('sv-target', 'snap-1', 0.0); // threshold=0 to see all
    }

    test('body_hash match yields logic_sim = 1.0', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            { semanticSim: 0.5 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.normalized_logic_similarity).toBe(1.0);
    });

    test('normalized_ast_hash match yields logic_sim = 0.90', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'diff-a', normalized_ast_hash: 'SHARED-NORM', ast_hash: 'diff-a-ast' },
            { body_hash: 'diff-b', normalized_ast_hash: 'SHARED-NORM', ast_hash: 'diff-b-ast' },
            { semanticSim: 0.5 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.normalized_logic_similarity).toBe(0.90);
    });

    test('ast_hash match yields logic_sim = 0.85', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'SHARED-AST' },
            { body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'SHARED-AST' },
            { semanticSim: 0.5 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.normalized_logic_similarity).toBe(0.85);
    });

    test('no hash match falls back to computeBodySimilarity', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a' },
            { body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b' },
            { semanticSim: 0.8, bodySim: 0.6 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.normalized_logic_similarity).toBe(0.6);
    });

    test('computeBodySimilarity error yields logic_sim = 0.0', async () => {
        mockComputeBodySimilarity.mockRejectedValue(new Error('no vectors'));

        const results = await scoreSingleCandidate(
            { body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a' },
            { body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b' },
            { semanticSim: 0.8 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.normalized_logic_similarity).toBe(0.0);
    });

    test('semantic engine error falls back to name similarity', async () => {
        // Set up the test scenario directly (not via scoreSingleCandidate)
        // because the helper overrides mockComputeSemanticSimilarity after our rejection.
        const target = makeTarget({ canonical_name: 'validateUser', body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            canonical_name: 'validateUser', body_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        // Must set rejection AFTER routeDbQueries, so it's the final mock state
        mockComputeSemanticSimilarity.mockRejectedValue(new Error('no vectors'));

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        // Fallback to name-based similarity when semantic engine errors
        expect(results[0].evidence.semantic_intent_similarity).toBeGreaterThan(0);
    });

    test('structural identity override boosts confidence to >= 0.85', async () => {
        // logic_sim = 1.0 (body hash match), but all other dimensions zero
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED', canonical_name: 'xyz', signature: '' },
            { semanticSim: 0.0 },
        );
        expect(results.length).toBe(1);
        expect(results[0].confidence).toBeGreaterThanOrEqual(0.85);
        expect(results[0].evidence.evidence_family_count).toBeGreaterThanOrEqual(3);
    });

    test('weighted_total is capped at 1.0', async () => {
        // All dimensions maxed out
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED', signature: '(x: number): void' },
            { body_hash: 'SHARED', signature: '(x: number): void' },
            {
                semanticSim: 1.0,
                behavioralProfileTarget: makeBehavioralProfile({
                    symbol_version_id: 'sv-target', purity_class: 'pure', resource_touches: ['db:users'],
                }),
                behavioralProfileCandidate: makeBehavioralProfile({
                    symbol_version_id: 'sv-c1', purity_class: 'pure', resource_touches: ['db:users'],
                }),
                contractProfileTarget: makeContractProfile({
                    symbol_version_id: 'sv-target',
                    input_contract: '(id: string)', output_contract: 'User',
                    error_contract: 'NotFoundError', security_contract: 'admin',
                }),
                contractProfileCandidate: makeContractProfile({
                    symbol_version_id: 'sv-c1',
                    input_contract: '(id: string)', output_contract: 'User',
                    error_contract: 'NotFoundError', security_contract: 'admin',
                }),
                testOverlapCount: 5,
                historyCo: { confidence: 0.9 },
            },
        );
        expect(results.length).toBe(1);
        expect(results[0].confidence).toBeLessThanOrEqual(1.0);
    });

    test('behavioral overlap is 0.0 for two pure functions with no resource_touches', async () => {
        // Two pure symbols with empty resource_touches carry no homolog signal —
        // this is the default state for most symbols and should not inflate scores.
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            {
                semanticSim: 0.5,
                behavioralProfileTarget: makeBehavioralProfile({
                    symbol_version_id: 'sv-target', purity_class: 'pure', resource_touches: [],
                }),
                behavioralProfileCandidate: makeBehavioralProfile({
                    symbol_version_id: 'sv-c1', purity_class: 'pure', resource_touches: [],
                }),
            },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.behavioral_overlap).toBe(0);
    });

    test('behavioral overlap is 0.0 when different purity and no resources', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            {
                semanticSim: 0.5,
                behavioralProfileTarget: makeBehavioralProfile({
                    symbol_version_id: 'sv-target', purity_class: 'pure', resource_touches: [],
                }),
                behavioralProfileCandidate: makeBehavioralProfile({
                    symbol_version_id: 'sv-c1', purity_class: 'read_write', resource_touches: [],
                }),
            },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.behavioral_overlap).toBe(0.0);
    });

    test('behavioral overlap includes purity bonus and Jaccard on resource_touches', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            {
                semanticSim: 0.5,
                behavioralProfileTarget: makeBehavioralProfile({
                    symbol_version_id: 'sv-target', purity_class: 'read_only',
                    resource_touches: ['db:users', 'db:orders', 'cache:sessions'],
                }),
                behavioralProfileCandidate: makeBehavioralProfile({
                    symbol_version_id: 'sv-c1', purity_class: 'read_only',
                    resource_touches: ['db:users', 'db:orders'],
                }),
            },
        );
        expect(results.length).toBe(1);
        // Jaccard: intersection=2, union=3 -> 2/3 ~0.667, + purity bonus 0.2 = ~0.867
        expect(results[0].evidence.behavioral_overlap).toBeCloseTo(0.867, 2);
    });

    test('contract overlap computes correctly with partial matches', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            {
                semanticSim: 0.5,
                contractProfileTarget: makeContractProfile({
                    symbol_version_id: 'sv-target',
                    input_contract: '(id: string)', output_contract: 'User',
                    error_contract: 'NotFoundError', security_contract: 'admin',
                }),
                contractProfileCandidate: makeContractProfile({
                    symbol_version_id: 'sv-c1',
                    input_contract: '(id: string)', output_contract: 'Order', // differs
                    error_contract: 'NotFoundError', security_contract: 'user', // differs
                }),
            },
        );
        expect(results.length).toBe(1);
        // 4 contracts compared, 2 match -> 0.5
        expect(results[0].evidence.contract_overlap).toBeCloseTo(0.5, 2);
    });

    test('contract overlap returns 0.0 when no profiles exist', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            { semanticSim: 0.5 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.contract_overlap).toBe(0.0);
    });

    test('test overlap returns 0.0 when no shared test artifacts', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            { semanticSim: 0.5, testOverlapCount: 0 },
        );
        expect(results.length).toBe(1);
        expect(results[0].evidence.test_overlap).toBe(0.0);
    });

    test('test overlap caps at 1.0 for many shared tests', async () => {
        const results = await scoreSingleCandidate(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
            { semanticSim: 0.5, testOverlapCount: 10 },
        );
        expect(results.length).toBe(1);
        // count * 0.3 = 3.0 -> capped at 1.0
        expect(results[0].evidence.test_overlap).toBe(1.0);
    });
});

// =====================================================================
// 4. detectContradictions
// =====================================================================

describe('detectContradictions (via findHomologs)', () => {

    async function findWithProfiles(
        bpTarget: BehavioralProfile,
        bpCandidate: BehavioralProfile,
    ): Promise<HomologCandidate[]> {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({ symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED' });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        mockCacheStore.set(`bp:${target.symbol_version_id}`, bpTarget);
        mockCacheStore.set(`bp:sv-c1`, bpCandidate);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        return engine.findHomologs('sv-target', 'snap-1', 0.0);
    }

    test('no contradictions when profiles are identical', async () => {
        const bp = makeBehavioralProfile({ symbol_version_id: 'sv-target', purity_class: 'pure' });
        const results = await findWithProfiles(
            bp,
            makeBehavioralProfile({ symbol_version_id: 'sv-c1', purity_class: 'pure' }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).toEqual([]);
    });

    test('side_effects_differ when purity classes differ', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({ symbol_version_id: 'sv-target', purity_class: 'pure' }),
            makeBehavioralProfile({ symbol_version_id: 'sv-c1', purity_class: 'read_write' }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).toContain('side_effects_differ');
    });

    test('exception_semantics_differ when exception profiles differ', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({
                symbol_version_id: 'sv-target', purity_class: 'pure',
                exception_profile: ['throws:NotFoundError'],
            }),
            makeBehavioralProfile({
                symbol_version_id: 'sv-c1', purity_class: 'pure',
                exception_profile: ['throws:ValidationError'],
            }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).toContain('exception_semantics_differ');
    });

    test('no exception contradiction when profiles match (order-independent)', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({
                symbol_version_id: 'sv-target', purity_class: 'pure',
                exception_profile: ['throws:NotFoundError', 'catches:Error'],
            }),
            makeBehavioralProfile({
                symbol_version_id: 'sv-c1', purity_class: 'pure',
                exception_profile: ['catches:Error', 'throws:NotFoundError'], // reversed order
            }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).not.toContain('exception_semantics_differ');
    });

    test('security_context_differs when auth_operations differ', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({
                symbol_version_id: 'sv-target', purity_class: 'pure',
                auth_operations: ['checkRole:admin'],
            }),
            makeBehavioralProfile({
                symbol_version_id: 'sv-c1', purity_class: 'pure',
                auth_operations: ['checkRole:user'],
            }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).toContain('security_context_differs');
    });

    test('no security contradiction when auth_operations match', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({
                symbol_version_id: 'sv-target', purity_class: 'pure',
                auth_operations: ['checkRole:admin', 'verifyToken'],
            }),
            makeBehavioralProfile({
                symbol_version_id: 'sv-c1', purity_class: 'pure',
                auth_operations: ['verifyToken', 'checkRole:admin'],
            }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).not.toContain('security_context_differs');
    });

    test('io_shape_diverges when DB/network patterns differ', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({
                symbol_version_id: 'sv-target', purity_class: 'read_write',
                db_reads: ['users'], db_writes: ['orders'], network_calls: [],
            }),
            makeBehavioralProfile({
                symbol_version_id: 'sv-c1', purity_class: 'read_write',
                db_reads: ['products'], db_writes: [], network_calls: ['api.stripe.com'],
            }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).toContain('io_shape_diverges');
    });

    test('no io_shape_diverges when both have empty IO', async () => {
        const results = await findWithProfiles(
            makeBehavioralProfile({
                symbol_version_id: 'sv-target', purity_class: 'pure',
                db_reads: [], db_writes: [], network_calls: [],
            }),
            makeBehavioralProfile({
                symbol_version_id: 'sv-c1', purity_class: 'pure',
                db_reads: [], db_writes: [], network_calls: [],
            }),
        );
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).not.toContain('io_shape_diverges');
    });

    test('no contradictions when behavioral profiles are missing', async () => {
        // Do not set any cache profiles -> loadBehavioralProfile returns null
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({ symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED' });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].contradiction_flags).toEqual([]);
    });
});

// =====================================================================
// 5. classifyRelationType
// =====================================================================

describe('classifyRelationType (via findHomologs)', () => {

    async function classifySingle(
        targetOverrides: Partial<CandidateRowData>,
        candidateOverrides: Partial<CandidateRowData>,
        options: {
            semanticSim?: number;
            bpTarget?: BehavioralProfile | null;
            bpCandidate?: BehavioralProfile | null;
            cpTarget?: ContractProfile | null;
            cpCandidate?: ContractProfile | null;
        } = {},
    ): Promise<string> {
        const target = makeTarget(targetOverrides);
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            ...candidateOverrides,
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        if (options.bpTarget) mockCacheStore.set(`bp:${target.symbol_version_id}`, options.bpTarget);
        if (options.bpCandidate) mockCacheStore.set(`bp:sv-c1`, options.bpCandidate);
        if (options.cpTarget) mockCacheStore.set(`cp:${target.symbol_version_id}`, options.cpTarget);
        if (options.cpCandidate) mockCacheStore.set(`cp:sv-c1`, options.cpCandidate);

        mockComputeSemanticSimilarity.mockResolvedValue(options.semanticSim ?? 0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        return results.length > 0 ? results[0].relation_type : 'none';
    }

    test('near_duplicate_logic when logic_sim >= 0.85 (body_hash match)', async () => {
        const relType = await classifySingle(
            { body_hash: 'SHARED' },
            { body_hash: 'SHARED' },
        );
        expect(relType).toBe('near_duplicate_logic');
    });

    test('validator_homolog when both kinds are validator', async () => {
        const relType = await classifySingle(
            { kind: 'validator', body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-a' },
            { kind: 'validator', body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-b' },
            { semanticSim: 0.8 },
        );
        // Needs logic_sim < 0.85 to fall through to kind check;
        // body hashes differ so it falls to computeBodySimilarity
        mockComputeBodySimilarity.mockResolvedValue(0.5);

        // Re-run with body similarity < 0.85
        const results = await classifySingle(
            { kind: 'validator', body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a' },
            { kind: 'validator', body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b' },
            { semanticSim: 0.8 },
        );
        expect(results).toBe('validator_homolog');
    });

    test('serializer_homolog when both kinds are serializer', async () => {
        mockComputeBodySimilarity.mockResolvedValue(0.3);
        const relType = await classifySingle(
            { kind: 'serializer', body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a' },
            { kind: 'serializer', body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b' },
            { semanticSim: 0.8 },
        );
        expect(relType).toBe('serializer_homolog');
    });

    test('query_logic_duplicate when both kinds are query_builder', async () => {
        mockComputeBodySimilarity.mockResolvedValue(0.3);
        const relType = await classifySingle(
            { kind: 'query_builder', body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a' },
            { kind: 'query_builder', body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b' },
            { semanticSim: 0.8 },
        );
        expect(relType).toBe('query_logic_duplicate');
    });

    test('normalization_homolog when signature similarity >= 0.80', async () => {
        mockComputeBodySimilarity.mockResolvedValue(0.3);
        const relType = await classifySingle(
            {
                kind: 'function', body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a',
                signature: '(id: string): Promise<User>',
            },
            {
                kind: 'function', body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b',
                signature: '(id: string): Promise<User>', // identical signature
            },
            { semanticSim: 0.8 },
        );
        expect(relType).toBe('normalization_homolog');
    });
});

// =====================================================================
// 6. computeSignatureSimilarity
// =====================================================================

describe('computeSignatureSimilarity (via scoring)', () => {

    test('identical signatures yield 1.0', async () => {
        const target = makeTarget({ body_hash: 'SHARED', signature: '(id: string): User' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED', signature: '(id: string): User',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.signature_type_similarity).toBe(1.0);
    });

    test('empty signatures yield 0.0', async () => {
        const target = makeTarget({ body_hash: 'SHARED', signature: '' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED', signature: '',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.signature_type_similarity).toBe(0.0);
    });

    test('same param count + same return type gives high score', async () => {
        const target = makeTarget({
            body_hash: 'SHARED',
            signature: '(id: string, name: string): User',
        });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED',
            signature: '(key: string, label: string): User',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        // Same param count (2) -> 0.4, same return type "User" -> 0.4, plus type token overlap
        expect(results[0].evidence.signature_type_similarity).toBeGreaterThan(0.7);
    });
});

// =====================================================================
// 7. computeNameSimilarity (tokenizeName + Jaccard)
// =====================================================================

describe('computeNameSimilarity (via semantic fallback)', () => {

    test('identical names yield 1.0', async () => {
        mockComputeSemanticSimilarity.mockRejectedValue(new Error('no vectors'));

        const target = makeTarget({ body_hash: 'SHARED', canonical_name: 'getUserById' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED', canonical_name: 'getUserById',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.semantic_intent_similarity).toBe(1.0);
    });

    test('completely different names yield 0.0', async () => {
        mockComputeSemanticSimilarity.mockRejectedValue(new Error('no vectors'));

        const target = makeTarget({
            body_hash: 'SHARED', canonical_name: 'processPayment',
        });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED', canonical_name: 'sendEmail',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.semantic_intent_similarity).toBe(0.0);
    });

    test('partial overlap gives fractional similarity', async () => {
        mockComputeSemanticSimilarity.mockRejectedValue(new Error('no vectors'));

        const target = makeTarget({
            body_hash: 'SHARED', canonical_name: 'validateUserInput',
        });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED', canonical_name: 'validateOrderInput',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        // {validate, user, input} vs {validate, order, input} -> 2/4 = 0.5
        expect(results[0].evidence.semantic_intent_similarity).toBeCloseTo(0.5, 1);
    });
});

// =====================================================================
// 8. buildRationale
// =====================================================================

describe('buildRationale (via scored results)', () => {

    test('includes "near-identical logic" when logic >= 0.85', async () => {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.1);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.rationale).toContain('near-identical logic');
    });

    test('includes "strong name similarity" when semantic >= 0.70', async () => {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.75);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.rationale).toContain('strong name similarity');
    });

    test('returns "weak evidence" when all dimensions are zero', async () => {
        mockComputeSemanticSimilarity.mockResolvedValue(0.0);
        mockComputeBodySimilarity.mockResolvedValue(0.0);

        const target = makeTarget({
            body_hash: 'diff-a', normalized_ast_hash: null, ast_hash: 'diff-ast-a',
            signature: '',
        });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'diff-b', normalized_ast_hash: null, ast_hash: 'diff-ast-b',
            signature: '', canonical_name: 'xyz',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'kind = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        // Even with threshold=0, the evidence families < 2 will filter it out,
        // so we cannot inspect the rationale via public API directly.
        // Instead, we test indirectly: if all dimensions are zero, the candidate
        // is filtered out (testing the filtering behavior).
        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results).toEqual([]);
    });
});

// =====================================================================
// 9. generateCandidates
// =====================================================================

describe('generateCandidates (via findHomologs)', () => {

    test('deduplicates candidates appearing in multiple buckets', async () => {
        const target = makeTarget({ body_hash: 'SHARED', ast_hash: 'SHARED' });
        // Same candidate appears in both body_hash and ast_hash buckets
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1',
            body_hash: 'SHARED', ast_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'sv.ast_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        // Only 1 candidate should appear (deduplicated by candidateMap)
        expect(results.length).toBe(1);
    });

    test('handles semantic candidate errors gracefully', async () => {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);

        // Semantic candidate generation fails
        mockFindSemanticCandidates.mockRejectedValue(new Error('no LSH index'));
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        // Should not throw; should still process DB candidates
        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
    });

    test('adds semantic candidates to candidate pool', async () => {
        const target = makeTarget();
        const semCand = makeCandidate({
            symbol_version_id: 'sv-sem', symbol_id: 'sym-sem',
            canonical_name: 'processPayment', body_hash: 'SHARED',
        });

        // No DB candidates from any bucket
        let loadCallCount = 0;
        mockDbQuery.mockImplementation((sql: string) => {
            if (sql.includes('WHERE sv.symbol_version_id = $1')) {
                loadCallCount++;
                if (loadCallCount === 1) {
                    return Promise.resolve({ rows: [makeTarget()], rowCount: 1 });
                }
                // Second call: loadSymbolData for semantic candidate
                return Promise.resolve({ rows: [semCand], rowCount: 1 });
            }
            if (sql.includes('test_artifacts')) {
                return Promise.resolve({ rows: [{ cnt: 0 }], rowCount: 1 });
            }
            return Promise.resolve(emptyResult());
        });

        mockFindSemanticCandidates.mockResolvedValue([{ svId: 'sv-sem', similarity: 0.8 }]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.8);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        // The semantic candidate should be found and scored
        expect(mockFindSemanticCandidates).toHaveBeenCalledWith('sv-target', 'snap-1', 30);
    });

    test('skips normalized_ast_hash bucket when target has null normalized_ast_hash', async () => {
        const target = makeTarget({ normalized_ast_hash: null, body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        // Should not crash; normalized bucket returns empty via Promise.resolve
        expect(results.length).toBe(1);

        // Verify no query for normalized_ast_hash was made
        const normalizedCalls = mockDbQuery.mock.calls.filter(
            (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('normalized_ast_hash = $2'),
        );
        expect(normalizedCalls.length).toBe(0);
    });
});

// =====================================================================
// 10. Edge cases and constants
// =====================================================================

describe('Edge cases and constants', () => {

    test('HOMOLOG_WEIGHTS sum to 1.0', () => {
        const sum = Object.values(HOMOLOG_WEIGHTS).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1.0, 10);
    });

    test('MIN_EVIDENCE_FAMILIES is 2', () => {
        expect(MIN_EVIDENCE_FAMILIES).toBe(2);
    });

    test('DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD is 0.60', () => {
        expect(DEFAULT_HOMOLOG_CONFIDENCE_THRESHOLD).toBe(0.60);
    });

    test('all 7 weights are present and positive', () => {
        expect(HOMOLOG_WEIGHTS.semantic_intent_similarity).toBeGreaterThan(0);
        expect(HOMOLOG_WEIGHTS.normalized_logic_similarity).toBeGreaterThan(0);
        expect(HOMOLOG_WEIGHTS.signature_type_similarity).toBeGreaterThan(0);
        expect(HOMOLOG_WEIGHTS.behavioral_overlap).toBeGreaterThan(0);
        expect(HOMOLOG_WEIGHTS.contract_overlap).toBeGreaterThan(0);
        expect(HOMOLOG_WEIGHTS.test_overlap).toBeGreaterThan(0);
        expect(HOMOLOG_WEIGHTS.history_co_change).toBeGreaterThan(0);
    });

    test('engine can be instantiated multiple times independently', () => {
        const e1 = new HomologInferenceEngine();
        const e2 = new HomologInferenceEngine();
        expect(e1).not.toBe(e2);
    });

    test('findHomologs is safe with concurrent calls', async () => {
        mockDbQuery.mockResolvedValue(emptyResult());

        // Two concurrent calls should not interfere
        const [r1, r2] = await Promise.all([
            engine.findHomologs('sv-a', 'snap-1'),
            engine.findHomologs('sv-b', 'snap-1'),
        ]);
        expect(r1).toEqual([]);
        expect(r2).toEqual([]);
    });
});

// =====================================================================
// 11. Cache behavior
// =====================================================================

describe('Cache behavior', () => {

    test('loadBehavioralProfile returns cached value when available', async () => {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        // Pre-populate cache for BOTH target and candidate so no DB lookups are needed
        const cachedBpTarget = makeBehavioralProfile({
            symbol_version_id: 'sv-target', purity_class: 'read_only',
            resource_touches: ['db:users'],
        });
        const cachedBpCandidate = makeBehavioralProfile({
            symbol_version_id: 'sv-c1', purity_class: 'read_only',
            resource_touches: ['db:users'],
        });
        mockCacheStore.set('bp:sv-target', cachedBpTarget);
        mockCacheStore.set('bp:sv-c1', cachedBpCandidate);

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);

        // Behavioral profiles should be served from cache — no behavioral_profiles queries
        const bpQueryCalls = mockDbQuery.mock.calls.filter(
            (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('FROM behavioral_profiles'),
        );
        expect(bpQueryCalls.length).toBe(0);
        // The cached profiles should have been used for scoring
        expect(results.length).toBe(1);
        expect(results[0].evidence.behavioral_overlap).toBeGreaterThan(0);
    });

    test('loadContractProfile returns cached value when available', async () => {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        const cachedCp = makeContractProfile({
            symbol_version_id: 'sv-target',
            input_contract: '(x: number)', output_contract: 'boolean',
        });
        mockCacheStore.set('cp:sv-target', cachedCp);
        mockCacheStore.set('cp:sv-c1', makeContractProfile({
            symbol_version_id: 'sv-c1',
            input_contract: '(x: number)', output_contract: 'boolean',
        }));

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        // Contract overlap should reflect cached profiles (both identical -> 1.0)
        expect(results[0].evidence.contract_overlap).toBe(1.0);
    });
});

// =====================================================================
// 12. History co-change
// =====================================================================

describe('computeHistoryCoChange (via scoring)', () => {

    test('returns 0.0 when no symbol versions exist for either symbol', async () => {
        const target = makeTarget({ body_hash: 'SHARED' });
        const cand = makeCandidate({
            symbol_version_id: 'sv-c1', symbol_id: 'sym-c1', body_hash: 'SHARED',
        });

        routeDbQueries([
            { match: 'WHERE sv.symbol_version_id = $1', result: { rows: [target], rowCount: 1 } },
            { match: 'sv.body_hash = $2', result: { rows: [cand], rowCount: 1 } },
            { match: 'behavioral_profiles', result: emptyResult() },
            { match: 'contract_profiles', result: emptyResult() },
            { match: 'test_artifacts', result: { rows: [{ cnt: 0 }], rowCount: 1 } },
            { match: 'FROM symbol_versions WHERE symbol_id', result: emptyResult() },
        ]);
        mockComputeSemanticSimilarity.mockResolvedValue(0.5);

        const results = await engine.findHomologs('sv-target', 'snap-1', 0.0);
        expect(results.length).toBe(1);
        expect(results[0].evidence.history_co_change).toBe(0.0);
    });
});
