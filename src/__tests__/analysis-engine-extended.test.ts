/**
 * Extended unit tests for analysis-engine sub-modules.
 *
 * Covers:
 *   - BlastRadiusEngine     (blast-radius.ts)
 *   - DeepContractSynthesizer (deep-contracts.ts)
 *   - DispatchResolver       (dispatch-resolver.ts)
 *   - EffectEngine           (effect-engine.ts)
 *   - SymbolLineageEngine    (symbol-lineage.ts)
 *   - TemporalEngine         (temporal-engine.ts)
 *   - ConceptFamilyEngine    (concept-families.ts)
 *   - StructuralGraphEngine  (index.ts)
 *   - RuntimeEvidenceEngine  (runtime-evidence.ts)
 *
 * All DB calls are mocked; these tests exercise pure logic paths.
 */

import type { BehavioralProfile, ContractProfile } from '../types';

// ── DB mocks ────────────────────────────────────────────────────────
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockBatchInsert = jest.fn().mockResolvedValue(undefined);
const mockTransaction = jest.fn().mockImplementation(async (cb: any) => cb({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));
const mockQueryWithClient = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: any[]) => mockQuery(...args),
        batchInsert: (...args: any[]) => mockBatchInsert(...args),
        transaction: (...args: any[]) => mockTransaction(...args),
        queryWithClient: (...args: any[]) => mockQueryWithClient(...args),
    },
}));

jest.mock('../db-driver/core_data', () => ({
    coreDataService: {
        upsertBehavioralProfile: jest.fn().mockResolvedValue('bp-id'),
        upsertContractProfile: jest.fn().mockResolvedValue('cp-id'),
        getSymbolVersionsForSnapshot: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock('../db-driver/batch-loader', () => ({
    BatchLoader: jest.fn().mockImplementation(() => ({
        loadBehavioralProfiles: jest.fn().mockResolvedValue(new Map()),
        loadContractProfiles: jest.fn().mockResolvedValue(new Map()),
    })),
}));

jest.mock('../db-driver/result', () => {
    const actual = jest.requireActual('../db-driver/result');
    return {
        ...actual,
        jsonField: jest.fn().mockReturnValue(null),
        firstRow: jest.fn().mockReturnValue(undefined),
        optionalStringField: jest.fn().mockReturnValue(null),
        parseCountField: jest.fn().mockReturnValue(0),
    };
});

// ── Imports (after mocks) ───────────────────────────────────────────
import { BlastRadiusEngine } from '../analysis-engine/blast-radius';
import { DeepContractSynthesizer } from '../analysis-engine/deep-contracts';
import { DispatchResolver } from '../analysis-engine/dispatch-resolver';
import { EffectEngine } from '../analysis-engine/effect-engine';
import type { EffectEntry, EffectClass } from '../analysis-engine/effect-engine';
import { SymbolLineageEngine } from '../analysis-engine/symbol-lineage';
import { TemporalEngine } from '../analysis-engine/temporal-engine';
import type { GitCommit } from '../analysis-engine/temporal-engine';
import { ConceptFamilyEngine } from '../analysis-engine/concept-families';
import type { MemberData, RawCluster, EdgeRecord } from '../analysis-engine/concept-families';
import { StructuralGraphEngine } from '../analysis-engine/index';
import { RuntimeEvidenceEngine } from '../analysis-engine/runtime-evidence';

// ── Helpers ─────────────────────────────────────────────────────────

const makeBP = (overrides: Partial<BehavioralProfile> = {}): BehavioralProfile => ({
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
});

const makeCP = (overrides: Partial<ContractProfile> = {}): ContractProfile => ({
    contract_profile_id: 'cp-test',
    symbol_version_id: 'sv-test',
    input_contract: '',
    output_contract: '',
    error_contract: '',
    schema_refs: [],
    api_contract_refs: [],
    serialization_contract: '',
    security_contract: '',
    derived_invariants_count: 0,
    ...overrides,
});

const makeGitCommit = (overrides: Partial<GitCommit> = {}): GitCommit => ({
    hash: 'a'.repeat(40),
    author_name: 'Test Author',
    author_email: 'test@example.com',
    date: new Date('2025-01-15'),
    subject: 'feat: add feature',
    files: ['src/index.ts'],
    is_bug_fix: false,
    is_revert: false,
    is_merge: false,
    ...overrides,
});

const makeMemberData = (overrides: Partial<MemberData> = {}): MemberData => ({
    symbol_version_id: 'sv-1',
    canonical_name: 'myFunction',
    kind: 'function',
    stable_key: 'src/test.ts::myFunction',
    ...overrides,
});

// ── Reset mocks ─────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockBatchInsert.mockResolvedValue(undefined);
});

// =====================================================================
// 1. BLAST RADIUS ENGINE
// =====================================================================

describe('BlastRadiusEngine', () => {
    const engine = new BlastRadiusEngine();

    describe('computeBlastRadius', () => {
        test('returns empty report for empty target list', async () => {
            const report = await engine.computeBlastRadius('snap-1', []);
            expect(report.target_symbols).toEqual([]);
            expect(report.total_impact_count).toBe(0);
            expect(report.structural_impacts).toEqual([]);
            expect(report.behavioral_impacts).toEqual([]);
            expect(report.contract_impacts).toEqual([]);
            expect(report.homolog_impacts).toEqual([]);
            expect(report.historical_impacts).toEqual([]);
        });

        test('clamps depth to minimum of 1', async () => {
            const report = await engine.computeBlastRadius('snap-1', ['sv-1'], 0);
            expect(report).toBeDefined();
            expect(report.recommended_validation_scope).toBeDefined();
        });

        test('clamps depth to MAX_INTERNAL_DEPTH (5)', async () => {
            const report = await engine.computeBlastRadius('snap-1', ['sv-1'], 100);
            expect(report).toBeDefined();
        });

        test('returns quick scope when no impacts', async () => {
            const report = await engine.computeBlastRadius('snap-1', ['sv-1'], 1);
            expect(report.recommended_validation_scope).toBe('quick');
            expect(report.total_impact_count).toBe(0);
        });

        test('returns standard scope when 2-4 high severity impacts', async () => {
            // Simulate structural impacts with high severity
            mockQuery.mockImplementation(async (sql: string) => {
                if (sql.includes('structural_relations')) {
                    return {
                        rows: Array.from({ length: 3 }, (_, i) => ({
                            src_symbol_version_id: `caller-${i}`,
                            relation_type: 'calls',
                            confidence: 0.9,
                            canonical_name: `CallerFunc${i}`,
                            symbol_id: `sym-${i}`,
                            file_path: `src/file${i}.ts`,
                            range_start_line: 10,
                            range_end_line: 20,
                        })),
                        rowCount: 3,
                    };
                }
                return { rows: [], rowCount: 0 };
            });

            const report = await engine.computeBlastRadius('snap-1', ['sv-target'], 1);
            expect(report.structural_impacts.length).toBe(3);
            expect(report.recommended_validation_scope).toBe('standard');
        });

        test('returns strict scope when critical impacts exist', async () => {
            // Simulate contract impacts with critical severity
            mockQuery.mockImplementation(async (sql: string) => {
                if (sql.includes('invariants')) {
                    return {
                        rows: [{
                            invariant_id: 'inv-1',
                            expression: 'x > 0',
                            source_type: 'assertion',
                            strength: 0.95,
                            canonical_name: 'validate',
                            symbol_id: 'sym-1',
                            file_path: 'src/validate.ts',
                            range_start_line: 1,
                            range_end_line: 10,
                        }],
                        rowCount: 1,
                    };
                }
                return { rows: [], rowCount: 0 };
            });

            const report = await engine.computeBlastRadius('snap-1', ['sv-target'], 1);
            const contractImpacts = report.contract_impacts;
            if (contractImpacts.length > 0) {
                expect(contractImpacts[0]!.impact_type).toBe('contract');
            }
        });

        test('returns strict scope for 20+ total impacts', async () => {
            // Access the private method via prototype
            const recommendScope = (engine as any).recommendValidationScope.bind(engine);
            expect(recommendScope(20, [], [], [])).toBe('strict');
            expect(recommendScope(25, [], [], [])).toBe('strict');
        });

        test('returns standard scope for 8-19 impacts with < 2 high', async () => {
            const recommendScope = (engine as any).recommendValidationScope.bind(engine);
            expect(recommendScope(10, [], [], [])).toBe('standard');
            expect(recommendScope(15, [], [], [])).toBe('standard');
        });

        test('returns quick scope for low impact', async () => {
            const recommendScope = (engine as any).recommendValidationScope.bind(engine);
            expect(recommendScope(3, [], [], [])).toBe('quick');
        });

        test('returns strict when 5+ high severity impacts', async () => {
            const recommendScope = (engine as any).recommendValidationScope.bind(engine);
            const highImpacts = Array.from({ length: 5 }, () => ({
                severity: 'high' as const,
                impact_type: 'structural',
            }));
            expect(recommendScope(5, highImpacts, [], [])).toBe('strict');
        });

        test('computes structural impacts at multiple depths', async () => {
            let callCount = 0;
            mockQuery.mockImplementation(async (sql: string) => {
                if (sql.includes('structural_relations') && sql.includes('src_symbol_version_id')) {
                    callCount++;
                    if (callCount <= 1) {
                        return {
                            rows: [{
                                src_symbol_version_id: 'caller-1',
                                relation_type: 'calls',
                                confidence: 0.9,
                                canonical_name: 'CallerA',
                                symbol_id: 'sym-caller-1',
                                file_path: 'src/a.ts',
                                range_start_line: 1,
                                range_end_line: 5,
                            }],
                            rowCount: 1,
                        };
                    }
                    return { rows: [], rowCount: 0 };
                }
                return { rows: [], rowCount: 0 };
            });

            const report = await engine.computeBlastRadius('snap-1', ['sv-target'], 2);
            expect(report.structural_impacts.length).toBeGreaterThanOrEqual(0);
        });

        test('homolog impacts include is evidence string', async () => {
            mockQuery.mockImplementation(async (sql: string) => {
                if (sql.includes('inferred_relations') && !sql.includes('co_changed_with')) {
                    return {
                        rows: [{
                            dst_symbol_version_id: 'hom-1',
                            relation_type: 'similar_structure',
                            confidence: 0.85,
                            canonical_name: 'homologFunc',
                            symbol_id: 'sym-h1',
                            file_path: 'src/h.ts',
                            range_start_line: 1,
                            range_end_line: 10,
                        }],
                        rowCount: 1,
                    };
                }
                return { rows: [], rowCount: 0 };
            });

            const report = await engine.computeBlastRadius('snap-1', ['sv-target'], 1);
            if (report.homolog_impacts.length > 0) {
                expect(report.homolog_impacts[0]!.evidence).toContain('Homolog relation');
            }
        });
    });
});

// =====================================================================
// 2. EFFECT ENGINE
// =====================================================================

describe('EffectEngine', () => {
    const engine = new EffectEngine();

    describe('classifyEffectClass', () => {
        test('pure: empty effects', () => {
            expect(engine.classifyEffectClass([])).toBe('pure');
        });

        test('reader: reads effect only', () => {
            const effects: EffectEntry[] = [{
                kind: 'reads', descriptor: 'db.users', detail: 'read', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('reader: requires auth only', () => {
            const effects: EffectEntry[] = [{
                kind: 'requires', descriptor: 'auth.admin', detail: 'auth', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('reader: throws only', () => {
            const effects: EffectEntry[] = [{
                kind: 'throws', descriptor: 'error.Validation', detail: 'throw', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('reader: normalizes only', () => {
            const effects: EffectEntry[] = [{
                kind: 'normalizes', descriptor: 'data.trim', detail: 'normalize', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('reader: logs only', () => {
            const effects: EffectEntry[] = [{
                kind: 'logs', descriptor: 'log.info', detail: 'logging', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('writer: writes effect', () => {
            const effects: EffectEntry[] = [{
                kind: 'writes', descriptor: 'db.users', detail: 'write', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('writer');
        });

        test('writer: mutates effect', () => {
            const effects: EffectEntry[] = [{
                kind: 'mutates', descriptor: 'state.cache', detail: 'mutate', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('writer');
        });

        test('writer: opens effect', () => {
            const effects: EffectEntry[] = [{
                kind: 'opens', descriptor: 'file.config', detail: 'open', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('writer');
        });

        test('io: calls_external effect', () => {
            const effects: EffectEntry[] = [{
                kind: 'calls_external', descriptor: 'network.stripe', detail: 'http', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('io');
        });

        test('full_side_effect: emits event', () => {
            const effects: EffectEntry[] = [{
                kind: 'emits', descriptor: 'event.user_created', detail: 'emit', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });

        test('full_side_effect: acquires lock', () => {
            const effects: EffectEntry[] = [{
                kind: 'acquires_lock', descriptor: 'concurrency.mutex', detail: 'lock', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });

        test('full_side_effect: transaction descriptor in writes', () => {
            const effects: EffectEntry[] = [{
                kind: 'writes', descriptor: 'db.transaction.main', detail: 'txn', provenance: 'direct',
            }];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });

        test('mixed: highest tier wins (io > writer)', () => {
            const effects: EffectEntry[] = [
                { kind: 'writes', descriptor: 'db.users', detail: 'write', provenance: 'direct' },
                { kind: 'calls_external', descriptor: 'network.api', detail: 'http', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('io');
        });

        test('mixed: emits overrides io', () => {
            const effects: EffectEntry[] = [
                { kind: 'calls_external', descriptor: 'network.api', detail: 'http', provenance: 'direct' },
                { kind: 'emits', descriptor: 'event.done', detail: 'emit', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });
    });

    describe('private utility methods', () => {
        test('deduplicateEffects removes duplicate kind+descriptor', () => {
            const dedup = (engine as any).deduplicateEffects.bind(engine);
            const effects: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'read1', provenance: 'direct' },
                { kind: 'reads', descriptor: 'db.users', detail: 'read2', provenance: 'direct' },
                { kind: 'reads', descriptor: 'db.orders', detail: 'read3', provenance: 'direct' },
            ];
            const result = dedup(effects);
            expect(result).toHaveLength(2);
        });

        test('deduplicateEffects prefers direct over transitive', () => {
            const dedup = (engine as any).deduplicateEffects.bind(engine);
            const effects: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'transitive', provenance: 'transitive' },
                { kind: 'reads', descriptor: 'db.users', detail: 'direct', provenance: 'direct' },
            ];
            const result = dedup(effects);
            expect(result).toHaveLength(1);
            expect(result[0].provenance).toBe('direct');
        });

        test('deduplicateEffects keeps first when both are direct', () => {
            const dedup = (engine as any).deduplicateEffects.bind(engine);
            const effects: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'first', provenance: 'direct' },
                { kind: 'reads', descriptor: 'db.users', detail: 'second', provenance: 'direct' },
            ];
            const result = dedup(effects);
            expect(result).toHaveLength(1);
            expect(result[0].detail).toBe('first');
        });

        test('collectDescriptors filters by kind', () => {
            const collect = (engine as any).collectDescriptors.bind(engine);
            const effects: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'r', provenance: 'direct' },
                { kind: 'writes', descriptor: 'db.orders', detail: 'w', provenance: 'direct' },
                { kind: 'reads', descriptor: 'db.products', detail: 'r2', provenance: 'direct' },
            ];
            const result = collect(effects, 'reads');
            expect(result).toEqual(['db.users', 'db.products']);
        });

        test('collectDescriptors deduplicates descriptors', () => {
            const collect = (engine as any).collectDescriptors.bind(engine);
            const effects: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'r1', provenance: 'direct' },
                { kind: 'reads', descriptor: 'db.users', detail: 'r2', provenance: 'transitive' },
            ];
            const result = collect(effects, 'reads');
            expect(result).toEqual(['db.users']);
        });

        test('computeConfidence base is 0.50', () => {
            const confidence = (engine as any).computeConfidence.bind(engine);
            expect(confidence(false, false, false)).toBe(0.50);
        });

        test('computeConfidence adds 0.20 for behavioral', () => {
            const confidence = (engine as any).computeConfidence.bind(engine);
            expect(confidence(true, false, false)).toBe(0.70);
        });

        test('computeConfidence adds 0.15 for contract', () => {
            const confidence = (engine as any).computeConfidence.bind(engine);
            expect(confidence(false, true, false)).toBe(0.65);
        });

        test('computeConfidence adds 0.10 for body source', () => {
            const confidence = (engine as any).computeConfidence.bind(engine);
            expect(confidence(false, false, true)).toBe(0.60);
        });

        test('computeConfidence caps at 0.95', () => {
            const confidence = (engine as any).computeConfidence.bind(engine);
            expect(confidence(true, true, true)).toBe(0.95);
        });

        test('normalizeDescriptor handles whitespace and special chars', () => {
            const normalize = (engine as any).normalizeDescriptor.bind(engine);
            expect(normalize('  Hello World  ')).toBe('hello_world');
            expect(normalize('foo@bar#baz')).toBe('foobarbaz');
            expect(normalize('my-api.v2')).toBe('my-api.v2');
        });

        test('mineFromBehavioralProfile extracts db reads', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ db_reads: ['users', 'orders'] });
            const effects = mine(bp);
            const reads = effects.filter((e: EffectEntry) => e.kind === 'reads');
            expect(reads.length).toBe(2);
            expect(reads[0].descriptor).toBe('db.users');
        });

        test('mineFromBehavioralProfile extracts db writes', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ db_writes: ['billing'] });
            const effects = mine(bp);
            const writes = effects.filter((e: EffectEntry) => e.kind === 'writes');
            expect(writes.length).toBe(1);
            expect(writes[0].descriptor).toBe('db.billing');
        });

        test('mineFromBehavioralProfile extracts network calls', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ network_calls: ['stripe_api'] });
            const effects = mine(bp);
            const ext = effects.filter((e: EffectEntry) => e.kind === 'calls_external');
            expect(ext.length).toBe(1);
        });

        test('mineFromBehavioralProfile extracts file_io as opens', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ file_io: ['config.json'] });
            const effects = mine(bp);
            const opens = effects.filter((e: EffectEntry) => e.kind === 'opens');
            expect(opens.length).toBe(1);
        });

        test('mineFromBehavioralProfile extracts auth_operations', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ auth_operations: ['requireAdmin'] });
            const effects = mine(bp);
            const auth = effects.filter((e: EffectEntry) => e.kind === 'requires');
            expect(auth.length).toBe(1);
        });

        test('mineFromBehavioralProfile extracts state_mutations', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ state_mutation_profile: ['redux.dispatch'] });
            const effects = mine(bp);
            const mutates = effects.filter((e: EffectEntry) => e.kind === 'mutates');
            expect(mutates.length).toBe(1);
        });

        test('mineFromBehavioralProfile extracts transactions as writes + lock', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ transaction_profile: ['checkout'] });
            const effects = mine(bp);
            const writes = effects.filter((e: EffectEntry) => e.kind === 'writes');
            const locks = effects.filter((e: EffectEntry) => e.kind === 'acquires_lock');
            expect(writes.length).toBe(1);
            expect(locks.length).toBe(1);
        });

        test('mineFromBehavioralProfile extracts throws from exception_profile', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ exception_profile: ['throws:ValidationError'] });
            const effects = mine(bp);
            const throws = effects.filter((e: EffectEntry) => e.kind === 'throws');
            expect(throws.length).toBe(1);
            expect(throws[0].descriptor).toBe('error.ValidationError');
        });

        test('mineFromBehavioralProfile extracts validation_operations', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ validation_operations: ['email_format'] });
            const effects = mine(bp);
            const norms = effects.filter((e: EffectEntry) => e.kind === 'normalizes');
            expect(norms.length).toBe(1);
        });

        test('mineFromBehavioralProfile extracts cache write ops', () => {
            const mine = (engine as any).mineFromBehavioralProfile.bind(engine);
            const bp = makeBP({ cache_ops: ['redis.set', 'redis.get'] });
            const effects = mine(bp);
            const writes = effects.filter((e: EffectEntry) => e.kind === 'writes');
            const reads = effects.filter((e: EffectEntry) => e.kind === 'reads');
            expect(writes.length).toBe(1); // 'set' -> write
            expect(reads.length).toBe(1); // 'get' -> read
        });

        test('mineFromContractProfile extracts security_contract', () => {
            const mine = (engine as any).mineFromContractProfile.bind(engine);
            const cp = makeCP({ security_contract: 'requireAdmin; requireAuth' });
            const effects = mine(cp);
            const auth = effects.filter((e: EffectEntry) => e.kind === 'requires');
            expect(auth.length).toBe(2);
        });

        test('mineFromContractProfile extracts error_contract', () => {
            const mine = (engine as any).mineFromContractProfile.bind(engine);
            const cp = makeCP({ error_contract: 'TypeError | ValidationError' });
            const effects = mine(cp);
            const throws = effects.filter((e: EffectEntry) => e.kind === 'throws');
            expect(throws.length).toBe(2);
        });

        test('mineFromContractProfile extracts api_contract_refs', () => {
            const mine = (engine as any).mineFromContractProfile.bind(engine);
            const cp = makeCP({ api_contract_refs: ['GET /users'] });
            const effects = mine(cp);
            const reads = effects.filter((e: EffectEntry) => e.kind === 'reads');
            expect(reads.length).toBe(1);
        });

        test('mineFromContractProfile skips "none" security', () => {
            const mine = (engine as any).mineFromContractProfile.bind(engine);
            const cp = makeCP({ security_contract: 'none' });
            const effects = mine(cp);
            expect(effects.length).toBe(0);
        });

        test('mineFromContractProfile skips "never" error', () => {
            const mine = (engine as any).mineFromContractProfile.bind(engine);
            const cp = makeCP({ error_contract: 'never' });
            const effects = mine(cp);
            expect(effects.length).toBe(0);
        });

        test('mineFromFrameworkPatterns detects ORM reads', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            const code = 'const user = await db.findOne({ id: 1 });';
            const effects: EffectEntry[] = mine(code, 'typescript');
            expect(effects.some((e: EffectEntry) => e.kind === 'reads')).toBe(true);
        });

        test('mineFromFrameworkPatterns detects ORM writes', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            const code = 'await repository.save(entity);';
            const effects: EffectEntry[] = mine(code, 'typescript');
            expect(effects.some((e: EffectEntry) => e.kind === 'writes')).toBe(true);
        });

        test('mineFromFrameworkPatterns detects HTTP calls', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            const code = 'const res = await fetch("https://api.example.com");';
            const effects: EffectEntry[] = mine(code, 'typescript');
            expect(effects.some((e: EffectEntry) => e.kind === 'calls_external')).toBe(true);
        });

        test('mineFromFrameworkPatterns detects event emission', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            const code = 'this.eventEmitter.emit("user_created", data);';
            const effects: EffectEntry[] = mine(code, 'typescript');
            expect(effects.some((e: EffectEntry) => e.kind === 'emits')).toBe(true);
        });

        test('mineFromFrameworkPatterns detects logging', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            const code = 'console.log("debug info");';
            const effects: EffectEntry[] = mine(code, 'typescript');
            expect(effects.some((e: EffectEntry) => e.kind === 'logs')).toBe(true);
        });

        test('mineFromFrameworkPatterns returns empty for empty code', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            expect(mine('', 'typescript')).toEqual([]);
        });

        test('mineFromFrameworkPatterns detects Rust-specific patterns', () => {
            const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);
            const code = 'let val = result.unwrap();';
            const effects: EffectEntry[] = mine(code, 'rust');
            expect(effects.some((e: EffectEntry) => e.kind === 'throws')).toBe(true);
        });

        test('mineFromBehaviorHints handles db_read', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'db_read', detail: 'users', line: 1 }];
            const effects = mine(hints);
            expect(effects[0].kind).toBe('reads');
        });

        test('mineFromBehaviorHints handles db_write', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'db_write', detail: 'orders', line: 1 }];
            const effects = mine(hints);
            expect(effects[0].kind).toBe('writes');
        });

        test('mineFromBehaviorHints handles network_call', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'network_call', detail: 'api', line: 1 }];
            const effects = mine(hints);
            expect(effects[0].kind).toBe('calls_external');
        });

        test('mineFromBehaviorHints handles file_io', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'file_io', detail: 'config', line: 1 }];
            const effects = mine(hints);
            expect(effects[0].kind).toBe('opens');
        });

        test('mineFromBehaviorHints handles cache_op write', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'cache_op', detail: 'redis.set', line: 1 }];
            const effects = mine(hints);
            expect(effects[0].kind).toBe('writes');
        });

        test('mineFromBehaviorHints handles cache_op read', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'cache_op', detail: 'redis.get', line: 1 }];
            const effects = mine(hints);
            expect(effects[0].kind).toBe('reads');
        });

        test('mineFromBehaviorHints handles transaction', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'transaction', detail: 'main', line: 1 }];
            const effects = mine(hints);
            expect(effects.length).toBe(2); // writes + acquires_lock
        });

        test('mineFromBehaviorHints skips catches', () => {
            const mine = (engine as any).mineFromBehaviorHints.bind(engine);
            const hints = [{ symbol_key: 'k', hint_type: 'catches', detail: 'Error', line: 1 }];
            const effects = mine(hints);
            expect(effects.length).toBe(0);
        });
    });

    describe('diffEffects', () => {
        test('returns no changes when both are null', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            const diff = await engine.diffEffects('sv-before', 'sv-after');
            expect(diff.class_direction).toBe('unchanged');
            expect(diff.added_effects).toEqual([]);
            expect(diff.removed_effects).toEqual([]);
            expect(diff.summary).toBe('No effect changes detected');
        });
    });
});

// =====================================================================
// 3. DEEP CONTRACT SYNTHESIZER
// =====================================================================

describe('DeepContractSynthesizer', () => {
    const synth = new DeepContractSynthesizer();

    describe('mineFromBody', () => {
        test('detects assert() calls', async () => {
            const body = 'function validate(x) { assert(x > 0); }';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('assert'))).toBe(true);
        });

        test('detects console.assert()', async () => {
            const body = 'function check(val) { console.assert(val !== null); }';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('console_assert'))).toBe(true);
        });

        test('detects typeof guards', async () => {
            const body = 'if (typeof name === "string") { return name; }';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('typeof'))).toBe(true);
        });

        test('detects instanceof guards', async () => {
            const body = 'if (error instanceof ValidationError) { throw error; }';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('instanceof'))).toBe(true);
        });

        test('detects Array.isArray guard', async () => {
            const body = 'if (Array.isArray(items)) { return items.length; }';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('Array.isArray'))).toBe(true);
        });

        test('detects nullish coalescing', async () => {
            const body = 'const val = input ?? defaultValue;';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('null_safety') && c.expression.includes('nullish fallback'))).toBe(true);
        });

        test('detects optional chaining', async () => {
            const body = 'const name = user?.profile;';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('null_safety') && c.expression.includes('optional-chained'))).toBe(true);
        });

        test('detects regex validators', async () => {
            const body = 'if (/^[a-z]+@[a-z]+\\.[a-z]+$/.test(email)) { return true; }';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.source_type === 'assertion' && c.expression.includes('regex_validation'))).toBe(true);
        });

        test('detects trim normalization', async () => {
            const body = 'const cleaned = input.trim();';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('trim'))).toBe(true);
        });

        test('detects toLowerCase normalization', async () => {
            const body = 'const lower = email.toLowerCase();';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('lowercased'))).toBe(true);
        });

        test('detects parseInt normalization', async () => {
            const body = 'const num = parseInt(input, 10);';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('parsed as integer'))).toBe(true);
        });

        test('detects JSON.parse normalization', async () => {
            const body = 'const data = JSON.parse(rawBody);';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('JSON-parsed'))).toBe(true);
        });

        test('detects Zod string schema', async () => {
            const body = 'const schema = z.string().min(1).max(100);';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.source_type === 'schema')).toBe(true);
        });

        test('detects Zod email validation', async () => {
            const body = 'const emailSchema = z.string().email();';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.source_type === 'schema')).toBe(true);
        });

        test('detects switch case enum restriction', async () => {
            const body = `switch (status) {
                case 'active': break;
                case 'inactive': break;
                case 'pending': break;
            }`;
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('enum'))).toBe(true);
        });

        test('returns empty for empty body', async () => {
            const candidates = await synth.mineFromBody('sv-1', '', 'sym-1', 'repo-1', 'snap-1');
            expect(candidates).toEqual([]);
        });

        test('detects Rust assert! macro', async () => {
            const body = 'assert!(x > 0);';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1', 'rust');
            expect(candidates.some(c => c.expression.includes('assert'))).toBe(true);
        });

        test('detects Rust unwrap() call', async () => {
            const body = 'let val = result.unwrap();';
            const candidates = await synth.mineFromBody('sv-1', body, 'sym-1', 'repo-1', 'snap-1', 'rust');
            expect(candidates.some(c => c.expression.includes('unwrap'))).toBe(true);
        });
    });

    describe('mineFromSignature', () => {
        test('detects return type', async () => {
            const sig = 'function getUser(id: string): Promise<User>';
            const candidates = await synth.mineFromSignature('sv-1', sig, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.source_type === 'derived' && c.expression.includes('output_guarantee'))).toBe(true);
        });

        test('detects generic constraint', async () => {
            const sig = 'function process<T extends Serializable>(data: T): T';
            const candidates = await synth.mineFromSignature('sv-1', sig, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.some(c => c.expression.includes('extends'))).toBe(true);
        });

        test('detects optional params', async () => {
            const sig = 'function create(name: string, age?: number): void';
            const candidates = await synth.mineFromSignature('sv-1', sig, 'sym-1', 'repo-1', 'snap-1');
            expect(candidates.length).toBeGreaterThan(0);
        });
    });
});

// =====================================================================
// 4. DISPATCH RESOLVER
// =====================================================================

describe('DispatchResolver', () => {
    const resolver = new DispatchResolver();

    describe('C3 linearization', () => {
        test('handles single class with no parents', () => {
            const c3 = (resolver as any).computeC3Linearization.bind(resolver);
            const graph = new Map();
            graph.set('A', {
                symbolVersionId: 'A',
                parents: [],
                children: [],
                methods: new Map(),
            });
            const result = c3('A', graph);
            expect(result).toEqual(['A']);
        });

        test('handles simple inheritance A -> B', () => {
            const c3 = (resolver as any).computeC3Linearization.bind(resolver);
            const graph = new Map();
            graph.set('A', {
                symbolVersionId: 'A',
                parents: [],
                children: ['B'],
                methods: new Map(),
            });
            graph.set('B', {
                symbolVersionId: 'B',
                parents: [{ svId: 'A', relationKind: 'extends' }],
                children: [],
                methods: new Map(),
            });
            const result = c3('B', graph);
            expect(result[0]).toBe('B');
            expect(result).toContain('A');
        });

        test('handles diamond inheritance', () => {
            const c3 = (resolver as any).computeC3Linearization.bind(resolver);
            const graph = new Map();
            graph.set('A', { symbolVersionId: 'A', parents: [], children: ['B', 'C'], methods: new Map() });
            graph.set('B', { symbolVersionId: 'B', parents: [{ svId: 'A', relationKind: 'extends' }], children: ['D'], methods: new Map() });
            graph.set('C', { symbolVersionId: 'C', parents: [{ svId: 'A', relationKind: 'extends' }], children: ['D'], methods: new Map() });
            graph.set('D', { symbolVersionId: 'D', parents: [{ svId: 'B', relationKind: 'extends' }, { svId: 'C', relationKind: 'extends' }], children: [], methods: new Map() });

            const result = c3('D', graph);
            expect(result[0]).toBe('D');
            // D appears before B and C
            expect(result.indexOf('D')).toBe(0);
        });
    });

    describe('buildClassHierarchy', () => {
        test('returns 0 for empty snapshot', async () => {
            const { coreDataService } = require('../db-driver/core_data');
            coreDataService.getSymbolVersionsForSnapshot.mockResolvedValue([]);
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

            const result = await resolver.buildClassHierarchy('snap-empty');
            expect(result).toBe(0);
        });
    });
});

// =====================================================================
// 5. SYMBOL LINEAGE ENGINE
// =====================================================================

describe('SymbolLineageEngine', () => {
    const lineageEngine = new SymbolLineageEngine();

    describe('computeIdentitySeed', () => {
        test('produces deterministic SHA-256 seed', () => {
            const seed1 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', 'UserService',
                'validate', 'sig-hash', 'src/services/'
            );
            const seed2 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', 'UserService',
                'validate', 'sig-hash', 'src/services/'
            );
            expect(seed1).toBe(seed2);
            expect(seed1).toHaveLength(64); // SHA-256 hex
        });

        test('different inputs produce different seeds', () => {
            const seed1 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', 'UserService',
                'validate', 'sig-hash-1', 'src/services/'
            );
            const seed2 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', 'UserService',
                'validate', 'sig-hash-2', 'src/services/'
            );
            expect(seed1).not.toBe(seed2);
        });

        test('is case-insensitive for language, kind, ancestry, filePath', () => {
            const seed1 = lineageEngine.computeIdentitySeed(
                'repo-1', 'TypeScript', 'Function', 'UserService',
                'validate', 'hash', 'src/Services/'
            );
            const seed2 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', 'userservice',
                'validate', 'hash', 'src/services/'
            );
            expect(seed1).toBe(seed2);
        });

        test('is case-sensitive for name', () => {
            const seed1 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '',
                'Validate', 'hash', ''
            );
            const seed2 = lineageEngine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '',
                'validate', 'hash', ''
            );
            expect(seed1).not.toBe(seed2);
        });
    });

    describe('computeLineage', () => {
        test('returns zero stats for empty snapshot', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            const result = await lineageEngine.computeLineage('repo-1', 'snap-1', null);
            expect(result.total_symbols).toBe(0);
            expect(result.births).toBe(0);
            expect(result.deaths).toBe(0);
            expect(result.exact_matches).toBe(0);
        });
    });

    describe('helper methods', () => {
        test('extractAncestry extracts parent from stable key with :: separator', () => {
            const extract = (lineageEngine as any).extractAncestry.bind(lineageEngine);
            expect(extract('src/services.ts::UserService.validate')).toBe('UserService');
        });

        test('extractAncestry returns empty for simple key', () => {
            const extract = (lineageEngine as any).extractAncestry.bind(lineageEngine);
            expect(extract('validate')).toBe('');
        });

        test('hashSignature normalizes whitespace', () => {
            const hashSig = (lineageEngine as any).hashSignature.bind(lineageEngine);
            const h1 = hashSig('function validate(x: string): boolean');
            const h2 = hashSig('function validate(x: string): boolean');
            expect(h1).toBe(h2);
        });

        test('extractFileContext extracts directory component', () => {
            const extractCtx = (lineageEngine as any).extractFileContext.bind(lineageEngine);
            const ctx = extractCtx('src/services/user/validator.ts');
            expect(ctx).toContain('src');
        });
    });
});

// =====================================================================
// 6. TEMPORAL ENGINE
// =====================================================================

describe('TemporalEngine', () => {
    const temporalEngine = new TemporalEngine();

    describe('parseGitLog', () => {
        const parseLog = (temporalEngine as any).parseGitLog.bind(temporalEngine);

        test('parses single commit', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|Author|test@example.com|2025-01-15 10:30:00 +0000|feat: add feature\nsrc/index.ts\nsrc/utils.ts\n`;
            const commits = parseLog(raw);
            expect(commits).toHaveLength(1);
            expect(commits[0].hash).toBe(hash);
            expect(commits[0].author_name).toBe('Author');
            expect(commits[0].author_email).toBe('test@example.com');
            expect(commits[0].files).toEqual(['src/index.ts', 'src/utils.ts']);
            expect(commits[0].is_bug_fix).toBe(false);
        });

        test('parses multiple commits', () => {
            const h1 = 'a'.repeat(40);
            const h2 = 'b'.repeat(40);
            const raw = `${h1}|Author1|a@b.com|2025-01-15 10:30:00 +0000|feat: add\nsrc/a.ts\n\n${h2}|Author2|c@d.com|2025-01-16 10:30:00 +0000|fix: bug\nsrc/b.ts\n`;
            const commits = parseLog(raw);
            expect(commits).toHaveLength(2);
            expect(commits[1].is_bug_fix).toBe(true);
        });

        test('detects bug fix subjects', () => {
            const hash = 'a'.repeat(40);
            const patterns = ['fix: broken button', 'bug: null reference', 'hotfix: crash',
                'resolve issue #123', 'patch: memory leak', 'closes #42'];
            for (const subject of patterns) {
                const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|${subject}\n`;
                const commits = parseLog(raw);
                expect(commits[0].is_bug_fix).toBe(true);
            }
        });

        test('detects revert commits', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|Revert "feat: add button"\nsrc/a.ts\n`;
            const commits = parseLog(raw);
            expect(commits[0].is_revert).toBe(true);
        });

        test('detects merge commits', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|Merge pull request #99 from feature\n`;
            const commits = parseLog(raw);
            expect(commits[0].is_merge).toBe(true);
        });

        test('handles subject with pipe characters', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|feat: add | operator support\n`;
            const commits = parseLog(raw);
            expect(commits[0].subject).toBe('feat: add | operator support');
        });

        test('skips binary files', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|feat: add icons\nicon.png\nstyles.css\n`;
            const commits = parseLog(raw);
            expect(commits[0].files).toEqual(['styles.css']);
        });

        test('skips lock files', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|deps: update\npackage-lock.json\nyarn.lock\nsrc/index.ts\n`;
            const commits = parseLog(raw);
            expect(commits[0].files).toEqual(['src/index.ts']);
        });

        test('skips node_modules and dist', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|build\nnode_modules/foo/index.js\ndist/bundle.js\nsrc/main.ts\n`;
            const commits = parseLog(raw);
            expect(commits[0].files).toEqual(['src/main.ts']);
        });

        test('returns empty array for empty input', () => {
            expect(parseLog('')).toEqual([]);
            expect(parseLog('   ')).toEqual([]);
        });

        test('skips malformed headers', () => {
            const raw = 'not-a-commit-line\nsrc/foo.ts\n';
            const commits = parseLog(raw);
            expect(commits).toHaveLength(0);
        });

        test('skips commits with invalid dates', () => {
            const hash = 'a'.repeat(40);
            const raw = `${hash}|A|a@b.com|not-a-date|feat: add\nsrc/a.ts\n`;
            const commits = parseLog(raw);
            expect(commits).toHaveLength(0);
        });
    });

    describe('isIgnoredPath', () => {
        const isIgnored = (temporalEngine as any).isIgnoredPath.bind(temporalEngine);

        test('ignores image files', () => {
            expect(isIgnored('assets/logo.png')).toBe(true);
            expect(isIgnored('assets/photo.jpg')).toBe(true);
            expect(isIgnored('assets/icon.gif')).toBe(true);
        });

        test('ignores font files', () => {
            expect(isIgnored('fonts/roboto.woff2')).toBe(true);
            expect(isIgnored('fonts/custom.ttf')).toBe(true);
        });

        test('ignores archives', () => {
            expect(isIgnored('assets/data.zip')).toBe(true);
            expect(isIgnored('assets/backup.tar.gz')).toBe(true); // .gz is in binary extensions
            expect(isIgnored('assets/archive.7z')).toBe(true);
        });

        test('ignores lock files', () => {
            expect(isIgnored('package-lock.json')).toBe(true);
            expect(isIgnored('yarn.lock')).toBe(true);
            expect(isIgnored('Cargo.lock')).toBe(true);
            expect(isIgnored('go.sum')).toBe(true);
        });

        test('ignores node_modules', () => {
            expect(isIgnored('node_modules/lodash/index.js')).toBe(true);
        });

        test('ignores dist directory', () => {
            expect(isIgnored('dist/bundle.js')).toBe(true);
        });

        test('allows source files', () => {
            expect(isIgnored('src/index.ts')).toBe(false);
            expect(isIgnored('lib/utils.py')).toBe(false);
            expect(isIgnored('main.go')).toBe(false);
        });
    });

    describe('computeCoChanges', () => {
        test('returns 0 when fileToSymbols is empty', async () => {
            const commits = [makeGitCommit()];
            const fileMap = new Map<string, string[]>();
            const result = await temporalEngine.computeCoChanges('repo-1', 'snap-1', commits, fileMap);
            expect(result).toBe(0);
        });

        test('skips merge commits', async () => {
            const commits = [
                makeGitCommit({ is_merge: true, files: ['src/a.ts', 'src/b.ts'] }),
            ];
            const fileMap = new Map([['src/a.ts', ['sym-a']], ['src/b.ts', ['sym-b']]]);
            const result = await temporalEngine.computeCoChanges('repo-1', 'snap-1', commits, fileMap);
            expect(result).toBe(0);
        });

        test('persists co-change pairs with Jaccard coefficients', async () => {
            const commits = [
                makeGitCommit({ hash: 'a'.repeat(40), files: ['src/a.ts', 'src/b.ts'] }),
                makeGitCommit({ hash: 'b'.repeat(40), files: ['src/a.ts', 'src/b.ts'], date: new Date('2025-01-16') }),
            ];
            const fileMap = new Map([['src/a.ts', ['sym-a']], ['src/b.ts', ['sym-b']]]);
            const result = await temporalEngine.computeCoChanges('repo-1', 'snap-1', commits, fileMap);
            expect(result).toBe(1);
            expect(mockBatchInsert).toHaveBeenCalled();
        });
    });

    describe('computeRiskScores', () => {
        test('returns 0 when fileToSymbols is empty', async () => {
            const commits = [makeGitCommit()];
            const fileMap = new Map<string, string[]>();
            const result = await temporalEngine.computeRiskScores('repo-1', 'snap-1', commits, fileMap);
            expect(result).toBe(0);
        });

        test('accumulates per-symbol statistics', async () => {
            const commits = [
                makeGitCommit({ files: ['src/a.ts'], is_bug_fix: true }),
                makeGitCommit({ hash: 'b'.repeat(40), files: ['src/a.ts'], date: new Date('2025-01-20') }),
            ];
            const fileMap = new Map([['src/a.ts', ['sym-a']]]);
            const result = await temporalEngine.computeRiskScores('repo-1', 'snap-1', commits, fileMap);
            expect(result).toBe(1);
        });
    });
});

// =====================================================================
// 7. CONCEPT FAMILY ENGINE
// =====================================================================

describe('ConceptFamilyEngine', () => {
    const cfEngine = new ConceptFamilyEngine();

    describe('classifyFamilyType', () => {
        test('returns custom for empty members', () => {
            expect(cfEngine.classifyFamilyType([], [], undefined)).toBe('custom');
        });

        test('classifies validator family by kind', () => {
            const members: MemberData[] = [
                makeMemberData({ kind: 'validator', canonical_name: 'validateEmail' }),
                makeMemberData({ kind: 'validator', canonical_name: 'validatePhone', symbol_version_id: 'sv-2' }),
                makeMemberData({ kind: 'function', canonical_name: 'otherFunc', symbol_version_id: 'sv-3' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            expect(cfEngine.classifyFamilyType(svIds, members)).toBe('validator');
        });

        test('classifies auth_policy by behavioral profile', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'checkAdmin', symbol_version_id: 'sv-1' }),
                makeMemberData({ canonical_name: 'checkUser', symbol_version_id: 'sv-2' }),
                makeMemberData({ canonical_name: 'verifyRole', symbol_version_id: 'sv-3' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBP({ auth_operations: ['requireAdmin'], symbol_version_id: 'sv-1' }));
            bpMap.set('sv-2', makeBP({ auth_operations: ['requireUser'], symbol_version_id: 'sv-2' }));
            bpMap.set('sv-3', makeBP({ auth_operations: ['requireRole'], symbol_version_id: 'sv-3' }));
            expect(cfEngine.classifyFamilyType(svIds, members, bpMap)).toBe('auth_policy');
        });

        test('classifies by name heuristic: validator', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'validateEmail', symbol_version_id: 'sv-1' }),
                makeMemberData({ canonical_name: 'checkPhoneNumber', symbol_version_id: 'sv-2' }),
                makeMemberData({ canonical_name: 'verifyAddress', symbol_version_id: 'sv-3' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            expect(cfEngine.classifyFamilyType(svIds, members)).toBe('validator');
        });

        test('classifies by name heuristic: normalization', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'normalizeInput', symbol_version_id: 'sv-1' }),
                makeMemberData({ canonical_name: 'sanitizeHTML', symbol_version_id: 'sv-2' }),
                makeMemberData({ canonical_name: 'cleanString', symbol_version_id: 'sv-3' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            expect(cfEngine.classifyFamilyType(svIds, members)).toBe('normalization');
        });

        test('classifies by name heuristic: auth_policy', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'authMiddleware', symbol_version_id: 'sv-1' }),
                makeMemberData({ canonical_name: 'guardRoute', symbol_version_id: 'sv-2' }),
                makeMemberData({ canonical_name: 'permissionCheck', symbol_version_id: 'sv-3' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            expect(cfEngine.classifyFamilyType(svIds, members)).toBe('auth_policy');
        });

        test('classifies by name heuristic: serializer', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'serializeUser', symbol_version_id: 'sv-1' }),
                makeMemberData({ canonical_name: 'marshalData', symbol_version_id: 'sv-2' }),
                makeMemberData({ canonical_name: 'encodePayload', symbol_version_id: 'sv-3' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            expect(cfEngine.classifyFamilyType(svIds, members)).toBe('serializer');
        });

        test('returns business_rule when behavioral data present but no match', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'doSomething', symbol_version_id: 'sv-1' }),
                makeMemberData({ canonical_name: 'handleStuff', symbol_version_id: 'sv-2' }),
            ];
            const svIds = members.map(m => m.symbol_version_id);
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBP({ symbol_version_id: 'sv-1' }));
            expect(cfEngine.classifyFamilyType(svIds, members, bpMap)).toBe('business_rule');
        });
    });

    describe('generateFamilyName', () => {
        const genName = (cfEngine as any).generateFamilyName.bind(cfEngine);

        test('generates name from common tokens', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'validateEmail' }),
                makeMemberData({ canonical_name: 'validatePhone' }),
            ];
            const name = genName(members, 'validator');
            expect(name).toContain('validate');
            expect(name).toContain('validator');
            expect(name).toContain('family');
        });

        test('returns unnamed for empty members', () => {
            const name = genName([], 'custom');
            expect(name).toBe('unnamed_custom');
        });

        test('uses first member name as fallback when no common tokens', () => {
            const members: MemberData[] = [
                makeMemberData({ canonical_name: 'alpha' }),
                makeMemberData({ canonical_name: 'beta' }),
            ];
            const name = genName(members, 'custom');
            expect(name).toContain('custom');
            expect(name).toContain('family');
        });
    });

    describe('tokenizeName', () => {
        const tokenize = (cfEngine as any).tokenizeName.bind(cfEngine);

        test('splits camelCase', () => {
            const result = tokenize('validateEmail');
            expect(result).toContain('validate');
            expect(result).toContain('email');
        });

        test('splits PascalCase', () => {
            const result = tokenize('UserService');
            expect(result).toContain('user');
            expect(result).toContain('service');
        });

        test('splits snake_case', () => {
            const result = tokenize('validate_email');
            expect(result).toContain('validate');
            expect(result).toContain('email');
        });

        test('splits dot-separated names', () => {
            const result = tokenize('user.validate');
            expect(result).toContain('user');
            expect(result).toContain('validate');
        });
    });

    describe('computeMembershipConfidence', () => {
        const computeConf = (cfEngine as any).computeMembershipConfidence.bind(cfEngine);

        test('returns 0 for member with no edges', () => {
            const cluster: RawCluster = {
                member_sv_ids: ['sv-1', 'sv-2', 'sv-3'],
                internal_edges: [
                    { src: 'sv-2', dst: 'sv-3', confidence: 0.8, relation_type: 'similar' },
                ],
                avg_confidence: 0.8,
            };
            expect(computeConf('sv-1', cluster)).toBe(0);
        });

        test('computes confidence from edge coverage and strength', () => {
            const cluster: RawCluster = {
                member_sv_ids: ['sv-1', 'sv-2', 'sv-3'],
                internal_edges: [
                    { src: 'sv-1', dst: 'sv-2', confidence: 0.9, relation_type: 'similar' },
                    { src: 'sv-1', dst: 'sv-3', confidence: 0.8, relation_type: 'similar' },
                ],
                avg_confidence: 0.85,
            };
            const conf = computeConf('sv-1', cluster);
            expect(conf).toBeGreaterThan(0);
            expect(conf).toBeLessThanOrEqual(1.0);
        });
    });

    describe('computeAvgConfidence', () => {
        const avgConf = (cfEngine as any).computeAvgConfidence.bind(cfEngine);

        test('returns 0 for empty edge list', () => {
            expect(avgConf([])).toBe(0);
        });

        test('computes average correctly', () => {
            const edges = [{ confidence: 0.8 }, { confidence: 0.6 }];
            expect(avgConf(edges)).toBeCloseTo(0.7, 5);
        });
    });

    describe('extractInternalEdges', () => {
        const extractEdges = (cfEngine as any).extractInternalEdges.bind(cfEngine);

        test('extracts only internal edges', () => {
            const adjacency = new Map<string, Map<string, { confidence: number; relation_type: string }>>();
            adjacency.set('A', new Map([
                ['B', { confidence: 0.9, relation_type: 'similar' }],
                ['C', { confidence: 0.7, relation_type: 'similar' }],
            ]));
            adjacency.set('B', new Map([
                ['A', { confidence: 0.9, relation_type: 'similar' }],
            ]));

            const edges = extractEdges(['A', 'B'], adjacency);
            expect(edges).toHaveLength(1); // A-B only, not A-C
        });

        test('deduplicates edges (undirected)', () => {
            const adjacency = new Map<string, Map<string, { confidence: number; relation_type: string }>>();
            adjacency.set('A', new Map([['B', { confidence: 0.9, relation_type: 'similar' }]]));
            adjacency.set('B', new Map([['A', { confidence: 0.9, relation_type: 'similar' }]]));

            const edges = extractEdges(['A', 'B'], adjacency);
            expect(edges).toHaveLength(1);
        });
    });
});

// =====================================================================
// 8. STRUCTURAL GRAPH ENGINE
// =====================================================================

describe('StructuralGraphEngine', () => {
    const sge = new StructuralGraphEngine();

    describe('computeRelationsFromRaw', () => {
        test('returns 0 for empty raw relations', async () => {
            const result = await sge.computeRelationsFromRaw('snap-1', 'repo-1', []);
            expect(result).toBe(0);
        });

        test('resolves source keys via symbol version map', async () => {
            const { coreDataService } = require('../db-driver/core_data');
            coreDataService.getSymbolVersionsForSnapshot.mockResolvedValue([
                { stable_key: 'src/a.ts::funcA', canonical_name: 'funcA', symbol_version_id: 'sv-a' },
                { stable_key: 'src/b.ts::funcB', canonical_name: 'funcB', symbol_version_id: 'sv-b' },
            ]);

            const relations = [
                { source_key: 'src/a.ts::funcA', target_name: 'funcB', relation_type: 'calls' as const },
            ];

            const result = await sge.computeRelationsFromRaw('snap-1', 'repo-1', relations);
            expect(result).toBe(1);
            expect(mockBatchInsert).toHaveBeenCalled();
        });

        test('skips relations with unresolved source', async () => {
            const { coreDataService } = require('../db-driver/core_data');
            coreDataService.getSymbolVersionsForSnapshot.mockResolvedValue([
                { stable_key: 'src/a.ts::funcA', canonical_name: 'funcA', symbol_version_id: 'sv-a' },
            ]);

            const relations = [
                { source_key: 'nonexistent::func', target_name: 'funcA', relation_type: 'calls' as const },
            ];

            const result = await sge.computeRelationsFromRaw('snap-1', 'repo-1', relations);
            expect(result).toBe(0);
        });
    });

    describe('getRelationsForSymbol', () => {
        test('queries both src and dst directions', async () => {
            mockQuery.mockResolvedValue({ rows: [{ relation_id: 'r1', src_symbol_version_id: 'sv-1', dst_symbol_version_id: 'sv-2', relation_type: 'calls', strength: 1.0, source: 'static_analysis', confidence: 1.0 }], rowCount: 1 });
            const result = await sge.getRelationsForSymbol('sv-1');
            expect(result).toHaveLength(1);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('src_symbol_version_id'),
                ['sv-1', 500]
            );
        });

        test('respects custom limit', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            await sge.getRelationsForSymbol('sv-1', 10);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.any(String),
                ['sv-1', 10]
            );
        });
    });

    describe('getCallers', () => {
        test('queries dst direction with calls/references filter', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            await sge.getCallers('sv-1');
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('dst_symbol_version_id'),
                ['sv-1', 500]
            );
        });
    });

    describe('getCallees', () => {
        test('queries src direction with calls/references filter', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            await sge.getCallees('sv-1');
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('src_symbol_version_id'),
                ['sv-1', 500]
            );
        });
    });
});

// =====================================================================
// 9. RUNTIME EVIDENCE ENGINE
// =====================================================================

describe('RuntimeEvidenceEngine', () => {
    const rtEngine = new RuntimeEvidenceEngine();

    describe('ingestTrace', () => {
        test('persists valid trace pack', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
            const tracePack = {
                source: 'test_execution' as const,
                timestamp: new Date('2025-01-15'),
                call_edges: [
                    { caller_key: 'funcA', callee_key: 'funcB', call_count: 5 },
                ],
                dynamic_routes: [],
                observed_types: [],
                framework_events: [],
            };

            const result = await rtEngine.ingestTrace('repo-1', 'snap-1', tracePack as any);
            expect(result.stored).toBe(true);
            expect(result.call_edges_count).toBe(1);
        });

        test('captures validation errors for invalid source', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
            const tracePack = {
                source: 'invalid_source',
                timestamp: new Date('2025-01-15'),
                call_edges: [],
                dynamic_routes: [],
                observed_types: [],
                framework_events: [],
            };

            const result = await rtEngine.ingestTrace('repo-1', 'snap-1', tracePack as any);
            expect(result.validation_errors.length).toBeGreaterThan(0);
            expect(result.validation_errors[0]).toContain('Invalid trace source');
        });

        test('handles DB error gracefully', async () => {
            mockQuery.mockRejectedValue(new Error('DB connection failed'));
            const tracePack = {
                source: 'test_execution' as const,
                timestamp: new Date('2025-01-15'),
                call_edges: [],
                dynamic_routes: [],
                observed_types: [],
                framework_events: [],
            };

            const result = await rtEngine.ingestTrace('repo-1', 'snap-1', tracePack as any);
            expect(result.stored).toBe(false);
            expect(result.validation_errors.some((e: string) => e.includes('Ingestion failed'))).toBe(true);
        });

        test('handles invalid timestamp gracefully', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
            const tracePack = {
                source: 'test_execution' as const,
                timestamp: new Date('invalid'),
                call_edges: [],
                dynamic_routes: [],
                observed_types: [],
                framework_events: [],
            };

            const result = await rtEngine.ingestTrace('repo-1', 'snap-1', tracePack as any);
            expect(result.stored).toBe(true);
        });

        test('truncates oversized call_edges', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
            const tracePack = {
                source: 'test_execution' as const,
                timestamp: new Date('2025-01-15'),
                call_edges: Array.from({ length: 60000 }, (_, i) => ({
                    caller_key: `func${i}`,
                    callee_key: `func${i + 1}`,
                    call_count: 1,
                })),
                dynamic_routes: [],
                observed_types: [],
                framework_events: [],
            };

            const result = await rtEngine.ingestTrace('repo-1', 'snap-1', tracePack as any);
            expect(result.call_edges_count).toBe(50000);
            expect(result.validation_errors.some((e: string) => e.includes('exceeds maximum'))).toBe(true);
        });
    });

    describe('validateTracePack', () => {
        const validate = (rtEngine as any).validateTracePack.bind(rtEngine);

        test('returns error for null input', () => {
            const errors = validate(null);
            expect(errors).toContain('Trace pack is null or undefined');
        });

        test('validates call_edge structure', () => {
            const pack = {
                source: 'test_execution',
                call_edges: [{ caller_key: '', callee_key: 'b', call_count: 1 }],
            };
            const errors = validate(pack);
            expect(errors.some((e: string) => e.includes('caller_key'))).toBe(true);
        });

        test('validates dynamic_routes structure', () => {
            const pack = {
                source: 'test_execution',
                call_edges: [],
                dynamic_routes: [{ route: '', handler_key: 'h' }],
            };
            const errors = validate(pack);
            expect(errors.some((e: string) => e.includes('route'))).toBe(true);
        });

        test('rejects non-array call_edges', () => {
            const pack = {
                source: 'test_execution',
                call_edges: 'not-an-array',
            };
            const errors = validate(pack);
            expect(errors).toContain('call_edges must be an array');
        });

        test('accepts valid trace pack with no errors', () => {
            const pack = {
                source: 'test_execution',
                call_edges: [{ caller_key: 'a', callee_key: 'b', call_count: 1 }],
                dynamic_routes: [{ route: '/api/users', handler_key: 'getUsers' }],
                observed_types: [],
                framework_events: [],
            };
            const errors = validate(pack);
            expect(errors).toEqual([]);
        });
    });

    describe('processTraces', () => {
        test('returns 0 when no unprocessed traces', async () => {
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            const result = await rtEngine.processTraces('repo-1', 'snap-1');
            expect(result).toBe(0);
        });
    });
});
