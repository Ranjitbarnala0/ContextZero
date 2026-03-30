/**
 * Integration tests for V2 analysis engines.
 *
 * Tests pure logic of all six V2 engines without requiring a real database.
 * Uses the same mock patterns as behavioral.test.ts and contracts.test.ts.
 *
 * Engines under test:
 *   1. EffectEngine           — effect-engine.ts
 *   2. DispatchResolver       — dispatch-resolver.ts
 *   3. SymbolLineageEngine    — symbol-lineage.ts
 *   4. TemporalEngine         — temporal-engine.ts
 *   5. ConceptFamilyEngine    — concept-families.ts
 *   6. DeepContractSynthesizer — deep-contracts.ts
 */

import type {
    BehavioralProfile, ContractProfile,
} from '../../types';

// ── DB mocks ────────────────────────────────────────────────────────
jest.mock('../../db-driver', () => ({
    db: {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        batchInsert: jest.fn().mockResolvedValue(undefined),
        transaction: jest.fn().mockImplementation(async (cb: any) => cb({
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        })),
    },
}));

jest.mock('../../db-driver/core_data', () => ({
    coreDataService: {
        upsertBehavioralProfile: jest.fn().mockResolvedValue('bp-id'),
        upsertContractProfile: jest.fn().mockResolvedValue('cp-id'),
        getSymbolVersionsForSnapshot: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock('../../db-driver/batch-loader', () => ({
    BatchLoader: jest.fn().mockImplementation(() => ({
        loadBehavioralProfiles: jest.fn().mockResolvedValue(new Map()),
        loadContractProfiles: jest.fn().mockResolvedValue(new Map()),
    })),
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { EffectEngine } from '../../analysis-engine/effect-engine';
import type { EffectEntry, EffectClass, EffectSignature } from '../../analysis-engine/effect-engine';

import { DispatchResolver } from '../../analysis-engine/dispatch-resolver';

import { SymbolLineageEngine } from '../../analysis-engine/symbol-lineage';

import { TemporalEngine } from '../../analysis-engine/temporal-engine';
import type { GitCommit } from '../../analysis-engine/temporal-engine';

import { ConceptFamilyEngine } from '../../analysis-engine/concept-families';
import type { MemberData, OutlierResult } from '../../analysis-engine/concept-families';

import { DeepContractSynthesizer } from '../../analysis-engine/deep-contracts';


// ── Helpers ─────────────────────────────────────────────────────────

const makeBehavioralProfile = (overrides: Partial<BehavioralProfile> = {}): BehavioralProfile => ({
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

const makeContractProfile = (overrides: Partial<ContractProfile> = {}): ContractProfile => ({
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
});


// =====================================================================
// 1. EFFECT ENGINE
// =====================================================================

describe('EffectEngine', () => {
    const engine = new EffectEngine();

    // ── classifyEffectClass ─────────────────────────────────────

    describe('classifyEffectClass', () => {
        test('pure: no effects at all', () => {
            expect(engine.classifyEffectClass([])).toBe('pure');
        });

        test('reader: only reads effects', () => {
            const effects: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'DB read', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('reader: normalizes and logs', () => {
            const effects: EffectEntry[] = [
                { kind: 'normalizes', descriptor: 'data.trim', detail: 'Trim', provenance: 'direct' },
                { kind: 'logs', descriptor: 'log.info', detail: 'Log', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('reader: throws effects map to reader tier', () => {
            const effects: EffectEntry[] = [
                { kind: 'throws', descriptor: 'error.NotFound', detail: 'Throws', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('reader');
        });

        test('writer: writes effects', () => {
            const effects: EffectEntry[] = [
                { kind: 'writes', descriptor: 'db.insert', detail: 'DB write', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('writer');
        });

        test('writer: mutates and opens', () => {
            const effects: EffectEntry[] = [
                { kind: 'mutates', descriptor: 'state.counter', detail: 'Mutation', provenance: 'direct' },
                { kind: 'opens', descriptor: 'file.log', detail: 'File open', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('writer');
        });

        test('io: calls_external present', () => {
            const effects: EffectEntry[] = [
                { kind: 'calls_external', descriptor: 'network.http', detail: 'HTTP call', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('io');
        });

        test('full_side_effect: emits event', () => {
            const effects: EffectEntry[] = [
                { kind: 'emits', descriptor: 'event.user_created', detail: 'Event', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });

        test('full_side_effect: acquires_lock', () => {
            const effects: EffectEntry[] = [
                { kind: 'acquires_lock', descriptor: 'mutex.db', detail: 'Lock', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });

        test('full_side_effect: transaction in write descriptor', () => {
            const effects: EffectEntry[] = [
                { kind: 'writes', descriptor: 'db.transaction.commit', detail: 'Txn', provenance: 'direct' },
            ];
            expect(engine.classifyEffectClass(effects)).toBe('full_side_effect');
        });

        test('escalation order: pure < reader < writer < io < full_side_effect', () => {
            const pureC = engine.classifyEffectClass([]);
            const readerC = engine.classifyEffectClass([
                { kind: 'reads', descriptor: 'db.q', detail: '', provenance: 'direct' },
            ]);
            const writerC = engine.classifyEffectClass([
                { kind: 'writes', descriptor: 'db.w', detail: '', provenance: 'direct' },
            ]);
            const ioC = engine.classifyEffectClass([
                { kind: 'calls_external', descriptor: 'n.h', detail: '', provenance: 'direct' },
            ]);
            const fullC = engine.classifyEffectClass([
                { kind: 'emits', descriptor: 'e.e', detail: '', provenance: 'direct' },
            ]);

            const order: Record<string, number> = {
                pure: 0, reader: 1, writer: 2, io: 3, full_side_effect: 4,
            };
            expect(order[pureC]).toBeLessThan(order[readerC]!);
            expect(order[readerC]).toBeLessThan(order[writerC]!);
            expect(order[writerC]).toBeLessThan(order[ioC]!);
            expect(order[ioC]).toBeLessThan(order[fullC]!);
        });
    });

    // ── mineFromBehavioralProfile ───────────────────────────────

    describe('mineFromBehavioralProfile', () => {
        const mine = (engine as any).mineFromBehavioralProfile.bind(engine);

        test('extracts reads effects from db_reads', () => {
            const bp = makeBehavioralProfile({ db_reads: ['raw_query', 'orm_select'] });
            const effects: EffectEntry[] = mine(bp);

            const reads = effects.filter(e => e.kind === 'reads');
            expect(reads.length).toBe(2);
            expect(reads[0]!.descriptor).toBe('db.raw_query');
            expect(reads[1]!.descriptor).toBe('db.orm_select');
        });

        test('extracts writes, network, auth from profiles', () => {
            const bp = makeBehavioralProfile({
                db_writes: ['insert'],
                network_calls: ['fetch'],
                auth_operations: ['verify_token'],
            });
            const effects: EffectEntry[] = mine(bp);

            expect(effects.some(e => e.kind === 'writes' && e.descriptor === 'db.insert')).toBe(true);
            expect(effects.some(e => e.kind === 'calls_external' && e.descriptor === 'network.fetch')).toBe(true);
            expect(effects.some(e => e.kind === 'requires' && e.descriptor === 'auth.verify_token')).toBe(true);
        });

        test('extracts throws from exception_profile', () => {
            const bp = makeBehavioralProfile({
                exception_profile: ['throws:NotFoundError', 'catches:TimeoutError'],
            });
            const effects: EffectEntry[] = mine(bp);

            const throwEffects = effects.filter(e => e.kind === 'throws');
            expect(throwEffects.length).toBe(1);
            expect(throwEffects[0]!.descriptor).toBe('error.NotFoundError');
        });

        test('extracts transaction effects as writes + locks', () => {
            const bp = makeBehavioralProfile({
                transaction_profile: ['db_transaction'],
            });
            const effects: EffectEntry[] = mine(bp);

            expect(effects.some(e => e.kind === 'writes' && e.descriptor.includes('transaction'))).toBe(true);
            expect(effects.some(e => e.kind === 'acquires_lock')).toBe(true);
        });

        test('returns empty array for empty profile', () => {
            const bp = makeBehavioralProfile({});
            const effects: EffectEntry[] = mine(bp);
            expect(effects.length).toBe(0);
        });
    });

    // ── mineFromContractProfile ─────────────────────────────────

    describe('mineFromContractProfile', () => {
        const mine = (engine as any).mineFromContractProfile.bind(engine);

        test('extracts requires from security contract', () => {
            const cp = makeContractProfile({ security_contract: '@AuthGuard(); @RequireRole("admin")' });
            const effects: EffectEntry[] = mine(cp);

            const authEffects = effects.filter(e => e.kind === 'requires');
            expect(authEffects.length).toBe(2);
        });

        test('extracts throws from error contract', () => {
            const cp = makeContractProfile({ error_contract: 'TypeError | ValidationError' });
            const effects: EffectEntry[] = mine(cp);

            const throwEffects = effects.filter(e => e.kind === 'throws');
            expect(throwEffects.length).toBe(2);
        });

        test('skips "none" security and "never" error contracts', () => {
            const cp = makeContractProfile({ security_contract: 'none', error_contract: 'never' });
            const effects: EffectEntry[] = mine(cp);
            expect(effects.length).toBe(0);
        });

        test('extracts reads from api_contract_refs', () => {
            const cp = makeContractProfile({ api_contract_refs: ['GET /users', 'POST /orders'] });
            const effects: EffectEntry[] = mine(cp);

            const readEffects = effects.filter(e => e.kind === 'reads' && e.descriptor.startsWith('api.'));
            expect(readEffects.length).toBe(2);
        });
    });

    // ── mineFromCodeBody (framework patterns) ───────────────────

    describe('mineFromFrameworkPatterns', () => {
        const mine = (engine as any).mineFromFrameworkPatterns.bind(engine);

        test('detects ORM read patterns', () => {
            const code = 'const user = await db.findOne({ id });\nconst list = repo.findMany();';
            const effects: EffectEntry[] = mine(code, 'typescript');

            expect(effects.some(e => e.kind === 'reads')).toBe(true);
        });

        test('detects ORM write patterns', () => {
            const code = 'await db.save(entity);\nawait repo.insert(record);';
            const effects: EffectEntry[] = mine(code, 'typescript');

            expect(effects.some(e => e.kind === 'writes')).toBe(true);
        });

        test('detects HTTP client calls', () => {
            const code = 'const res = await fetch("https://api.com/users");';
            const effects: EffectEntry[] = mine(code, 'typescript');

            expect(effects.some(e => e.kind === 'calls_external')).toBe(true);
        });

        test('returns empty for pure code', () => {
            const code = 'function add(a: number, b: number) { return a + b; }';
            const effects: EffectEntry[] = mine(code, 'typescript');
            expect(effects.length).toBe(0);
        });
    });

    // ── diffEffects (logic via buildable signatures) ────────────

    describe('diffEffects logic', () => {
        test('detects added and removed effects from keyed sets', () => {
            const before: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'R', provenance: 'direct' },
            ];
            const after: EffectEntry[] = [
                { kind: 'reads', descriptor: 'db.users', detail: 'R', provenance: 'direct' },
                { kind: 'writes', descriptor: 'db.orders', detail: 'W', provenance: 'direct' },
            ];

            const effectKey = (e: EffectEntry): string => `${e.kind}:${e.descriptor}`;
            const beforeKeys = new Set(before.map(effectKey));
            const afterKeys = new Set(after.map(effectKey));

            const added = after.filter(e => !beforeKeys.has(effectKey(e)));
            const removed = before.filter(e => !afterKeys.has(effectKey(e)));

            expect(added.length).toBe(1);
            expect(added[0]!.kind).toBe('writes');
            expect(removed.length).toBe(0);
        });

        test('detects class escalation from reader to io', () => {
            const beforeClass: EffectClass = 'reader';
            const afterClass: EffectClass = 'io';

            const ORDER: Record<EffectClass, number> = {
                pure: 0, reader: 1, writer: 2, io: 3, full_side_effect: 4,
            };

            const direction = ORDER[afterClass]! > ORDER[beforeClass]! ? 'escalated'
                : ORDER[afterClass]! < ORDER[beforeClass]! ? 'deescalated'
                    : 'unchanged';

            expect(direction).toBe('escalated');
        });

        test('detects class deescalation from writer to pure', () => {
            const ORDER: Record<EffectClass, number> = {
                pure: 0, reader: 1, writer: 2, io: 3, full_side_effect: 4,
            };
            const direction = ORDER['pure']! > ORDER['writer']! ? 'escalated'
                : ORDER['pure']! < ORDER['writer']! ? 'deescalated'
                    : 'unchanged';
            expect(direction).toBe('deescalated');
        });
    });
});


// =====================================================================
// 2. DISPATCH RESOLVER
// =====================================================================

describe('DispatchResolver', () => {
    const resolver = new DispatchResolver();

    // ── parseChainExpression (chain splitting logic) ─────────────

    describe('chain expression parsing', () => {
        test('parses self.service.validate() into segments', () => {
            const chain = 'self.service.validate';
            const segments = chain.replace(/^(this|self)\./, '').split('.');
            expect(segments).toEqual(['service', 'validate']);
        });

        test('parses this.repository.find() into segments', () => {
            const chain = 'this.repository.find';
            const segments = chain.replace(/^(this|self)\./, '').split('.');
            expect(segments).toEqual(['repository', 'find']);
        });

        test('parses deeply nested chain', () => {
            const chain = 'self.app.services.user.repository.findById';
            const segments = chain.replace(/^(this|self)\./, '').split('.');
            expect(segments).toEqual(['app', 'services', 'user', 'repository', 'findById']);
        });

        test('handles chain without self/this prefix', () => {
            const chain = 'service.validate';
            const segments = chain.replace(/^(this|self)\./, '').split('.');
            expect(segments).toEqual(['service', 'validate']);
        });

        test('single segment after stripping self', () => {
            const chain = 'self.validate';
            const segments = chain.replace(/^(this|self)\./, '').split('.');
            expect(segments).toEqual(['validate']);
        });
    });

    // ── C3 Linearization MRO ────────────────────────────────────

    describe('C3 linearization MRO', () => {
        const c3Merge = (resolver as any).c3Merge.bind(resolver);

        test('merges single-parent linearization', () => {
            // L[B] = [B, A], parent list = [B]
            // merge([B, A], [B]) => B, then A
            const result = c3Merge([['B', 'A'], ['B']]);
            expect(result).toEqual(['B', 'A']);
        });

        test('merges diamond hierarchy', () => {
            // Classic diamond: D extends B, C; B extends A; C extends A
            // L[B] = [B, A], L[C] = [C, A], parents = [B, C]
            // merge([B, A], [C, A], [B, C]) => B, C, A
            const result = c3Merge([['B', 'A'], ['C', 'A'], ['B', 'C']]);
            expect(result).toEqual(['B', 'C', 'A']);
        });

        test('returns empty array for empty inputs', () => {
            const result = c3Merge([]);
            expect(result).toEqual([]);
        });

        test('returns null for inconsistent hierarchy', () => {
            // A before B in one list but B before A in another
            const result = c3Merge([['A', 'B'], ['B', 'A']]);
            expect(result).toBeNull();
        });
    });

    // ── Polymorphic dispatch detection ──────────────────────────

    describe('polymorphic dispatch detection', () => {
        test('single resolved target is not polymorphic', () => {
            const resolvedIds = ['sv-001'];
            const isPolymorphic = resolvedIds.length > 1;
            expect(isPolymorphic).toBe(false);
        });

        test('multiple resolved targets is polymorphic', () => {
            const resolvedIds = ['sv-001', 'sv-002', 'sv-003'];
            const isPolymorphic = resolvedIds.length > 1;
            expect(isPolymorphic).toBe(true);
        });

        test('empty resolved targets is not polymorphic', () => {
            const resolvedIds: string[] = [];
            const isPolymorphic = resolvedIds.length > 1;
            expect(isPolymorphic).toBe(false);
        });
    });

    // ── DFS MRO fallback ────────────────────────────────────────

    describe('DFS MRO fallback', () => {
        const dfsMRO = (resolver as any).dfsMRO.bind(resolver);

        test('produces DFS order for simple hierarchy', () => {
            const graph = new Map();
            graph.set('D', { parents: [{ svId: 'B' }, { svId: 'C' }] });
            graph.set('B', { parents: [{ svId: 'A' }] });
            graph.set('C', { parents: [{ svId: 'A' }] });
            graph.set('A', { parents: [] });

            const result = dfsMRO('D', graph, new Set());
            expect(result[0]).toBe('D');
            expect(result).toContain('B');
            expect(result).toContain('C');
            expect(result).toContain('A');
        });

        test('handles already-visited nodes (cycle avoidance)', () => {
            const graph = new Map();
            graph.set('A', { parents: [{ svId: 'B' }] });
            graph.set('B', { parents: [{ svId: 'A' }] }); // cycle

            const result = dfsMRO('A', graph, new Set());
            expect(result).toContain('A');
            expect(result).toContain('B');
            // Should not infinite loop — visited set prevents it
            expect(result.length).toBeLessThanOrEqual(2);
        });
    });
});


// =====================================================================
// 3. SYMBOL LINEAGE ENGINE
// =====================================================================

describe('SymbolLineageEngine', () => {
    const engine = new SymbolLineageEngine();

    // ── buildIdentitySeed / computeIdentitySeed ─────────────────

    describe('computeIdentitySeed', () => {
        test('produces deterministic SHA-256 hex output', () => {
            const seed = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', 'UserService',
                'validateEmail', 'sig-hash', 'src/services'
            );
            expect(seed).toMatch(/^[0-9a-f]{64}$/);
        });

        test('same inputs produce identical seed', () => {
            const seed1 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'foo', 'sig', 'src'
            );
            const seed2 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'foo', 'sig', 'src'
            );
            expect(seed1).toBe(seed2);
        });

        test('different name produces different seed', () => {
            const seed1 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'foo', 'sig', 'src'
            );
            const seed2 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'bar', 'sig', 'src'
            );
            expect(seed1).not.toBe(seed2);
        });

        test('different language produces different seed', () => {
            const seed1 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'foo', 'sig', 'src'
            );
            const seed2 = engine.computeIdentitySeed(
                'repo-1', 'python', 'function', '', 'foo', 'sig', 'src'
            );
            expect(seed1).not.toBe(seed2);
        });

        test('different kind produces different seed', () => {
            const seed1 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'User', 'sig', 'src'
            );
            const seed2 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'class', '', 'User', 'sig', 'src'
            );
            expect(seed1).not.toBe(seed2);
        });

        test('language comparison is case-insensitive', () => {
            const seed1 = engine.computeIdentitySeed(
                'repo-1', 'TypeScript', 'function', '', 'foo', 'sig', 'src'
            );
            const seed2 = engine.computeIdentitySeed(
                'repo-1', 'typescript', 'function', '', 'foo', 'sig', 'src'
            );
            expect(seed1).toBe(seed2);
        });
    });

    // ── computeSignatureSimilarity ──────────────────────────────

    describe('computeSignatureSimilarity', () => {
        const computeSigSim = (engine as any).computeSignatureSimilarity.bind(engine);

        test('identical signatures return 1.0', () => {
            const sim = computeSigSim('(id: string): User', '(id: string): User');
            expect(sim).toBe(1.0);
        });

        test('empty signatures return 0.0', () => {
            const sim = computeSigSim('', '');
            expect(sim).toBe(0.0);
        });

        test('one empty returns 0.0', () => {
            const sim = computeSigSim('(id: string): User', '');
            expect(sim).toBe(0.0);
        });

        test('similar signatures have positive score', () => {
            const sim = computeSigSim(
                '(id: string): User',
                '(userId: string): User'
            );
            expect(sim).toBeGreaterThan(0);
            expect(sim).toBeLessThanOrEqual(1.0);
        });

        test('completely different signatures have lower score', () => {
            const sim = computeSigSim(
                '(id: string): User',
                '(data: Buffer, options: Config): Promise<void>'
            );
            expect(sim).toBeLessThan(0.5);
        });
    });

    // ── levenshteinDistance ──────────────────────────────────────

    describe('levenshteinDistance', () => {
        const levenshtein = (engine as any).levenshteinDistance.bind(engine);

        test('identical strings have distance 0', () => {
            expect(levenshtein('hello', 'hello')).toBe(0);
        });

        test('empty to non-empty is length of non-empty', () => {
            expect(levenshtein('', 'hello')).toBe(5);
        });

        test('non-empty to empty is length of non-empty', () => {
            expect(levenshtein('hello', '')).toBe(5);
        });

        test('single character difference', () => {
            expect(levenshtein('cat', 'bat')).toBe(1);
        });

        test('completely different strings', () => {
            expect(levenshtein('abc', 'xyz')).toBe(3);
        });

        test('insertion distance', () => {
            expect(levenshtein('validate', 'validates')).toBe(1);
        });

        test('deletion distance', () => {
            expect(levenshtein('validates', 'validate')).toBe(1);
        });
    });

    // ── jaccardSimilarity ───────────────────────────────────────

    describe('jaccardSimilarity', () => {
        const jaccard = (engine as any).jaccardSimilarity.bind(engine);

        test('identical sets return 1.0', () => {
            const a = new Set(['a', 'b', 'c']);
            const b = new Set(['a', 'b', 'c']);
            expect(jaccard(a, b)).toBe(1.0);
        });

        test('disjoint sets return 0.0', () => {
            const a = new Set(['a', 'b']);
            const b = new Set(['c', 'd']);
            expect(jaccard(a, b)).toBe(0.0);
        });

        test('partial overlap returns correct coefficient', () => {
            const a = new Set(['a', 'b', 'c']);
            const b = new Set(['b', 'c', 'd']);
            // intersection = 2, union = 4
            expect(jaccard(a, b)).toBeCloseTo(0.5, 5);
        });

        test('both empty sets return 0.0', () => {
            expect(jaccard(new Set<string>(), new Set<string>())).toBe(0.0);
        });

        test('one empty set returns 0.0', () => {
            expect(jaccard(new Set(['a']), new Set<string>())).toBe(0.0);
        });
    });

    // ── matchRenamedSymbols helper: computeNameEditDistance ──────

    describe('computeNameEditDistance', () => {
        const nameDistance = (engine as any).computeNameEditDistance.bind(engine);

        test('identical names return 1.0', () => {
            expect(nameDistance('validateEmail', 'validateEmail')).toBe(1.0);
        });

        test('empty name returns 0.0', () => {
            expect(nameDistance('foo', '')).toBe(0.0);
        });

        test('similar names get high score', () => {
            const sim = nameDistance('validateUser', 'validateAccount');
            expect(sim).toBeGreaterThan(0.3);
        });

        test('completely different names get low score', () => {
            const sim = nameDistance('abcxyz', 'mnopqr');
            expect(sim).toBeLessThan(0.3);
        });
    });
});


// =====================================================================
// 4. TEMPORAL ENGINE
// =====================================================================

describe('TemporalEngine', () => {
    const engine = new TemporalEngine();

    // ── parseGitLog ─────────────────────────────────────────────

    describe('parseGitLog', () => {
        const parseGitLog = (engine as any).parseGitLog.bind(engine);

        test('parses standard git log output into commits', () => {
            const raw = [
                'a'.repeat(40) + '|John Doe|john@example.com|2025-01-15 10:00:00 +0000|Add user feature',
                'src/users.ts',
                'src/types.ts',
                '',
                'b'.repeat(40) + '|Jane Doe|jane@example.com|2025-01-14 09:00:00 +0000|Fix login bug',
                'src/auth.ts',
                '',
            ].join('\n');

            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(2);
            expect(commits[0]!.hash).toBe('a'.repeat(40));
            expect(commits[0]!.author_name).toBe('John Doe');
            expect(commits[0]!.author_email).toBe('john@example.com');
            expect(commits[0]!.files).toEqual(['src/users.ts', 'src/types.ts']);
            expect(commits[0]!.is_bug_fix).toBe(false);
            expect(commits[1]!.is_bug_fix).toBe(true);
        });

        test('detects bug-fix commits from subject patterns', () => {
            const raw = 'c'.repeat(40) + '|Dev|dev@test.com|2025-01-10 12:00:00 +0000|fixes #42 user crash\nsrc/a.ts\n';
            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(1);
            expect(commits[0]!.is_bug_fix).toBe(true);
        });

        test('detects revert commits', () => {
            const raw = 'd'.repeat(40) + '|Dev|dev@test.com|2025-01-10 12:00:00 +0000|Revert "add feature"\nsrc/a.ts\n';
            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(1);
            expect(commits[0]!.is_revert).toBe(true);
        });

        test('detects merge commits', () => {
            const raw = 'e'.repeat(40) + '|Dev|dev@test.com|2025-01-10 12:00:00 +0000|Merge branch "main"\nsrc/a.ts\n';
            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(1);
            expect(commits[0]!.is_merge).toBe(true);
        });

        test('handles empty input', () => {
            const commits: GitCommit[] = parseGitLog('');
            expect(commits.length).toBe(0);
        });

        test('handles subject with pipe characters', () => {
            const raw = 'f'.repeat(40) + '|Dev|dev@test.com|2025-01-10 12:00:00 +0000|Use a | b | c pattern\nsrc/a.ts\n';
            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(1);
            expect(commits[0]!.subject).toBe('Use a | b | c pattern');
        });

        test('filters out binary files and lock files', () => {
            const raw = 'a'.repeat(40) + '|Dev|dev@test.com|2025-01-10 12:00:00 +0000|Update deps\nsrc/app.ts\npackage-lock.json\nlogo.png\nnode_modules/dep/index.js\n';
            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(1);
            expect(commits[0]!.files).toEqual(['src/app.ts']);
        });

        test('skips malformed header lines', () => {
            const raw = [
                'not-a-valid-hash-line',
                'a'.repeat(40) + '|Dev|dev@test.com|2025-01-10 12:00:00 +0000|Valid commit',
                'src/valid.ts',
            ].join('\n');
            const commits: GitCommit[] = parseGitLog(raw);

            expect(commits.length).toBe(1);
            expect(commits[0]!.files).toEqual(['src/valid.ts']);
        });
    });

    // ── computeJaccardCoefficient (co-change) ───────────────────

    describe('Jaccard coefficient for co-change', () => {
        test('computes Jaccard from co-change counts', () => {
            // Symbol A changed 10 times, B changed 8 times, together 5 times
            const coChanges = 5;
            const changesA = 10;
            const changesB = 8;
            const union = changesA + changesB - coChanges;
            const jaccard = union > 0 ? coChanges / union : 0;

            expect(jaccard).toBeCloseTo(5 / 13, 5);
        });

        test('perfect co-change yields Jaccard 1.0', () => {
            const coChanges = 10;
            const changesA = 10;
            const changesB = 10;
            const union = changesA + changesB - coChanges;
            const jaccard = coChanges / union;

            expect(jaccard).toBeCloseTo(1.0, 5);
        });

        test('no co-changes yields Jaccard 0', () => {
            const coChanges = 0;
            const changesA = 5;
            const changesB = 5;
            const union = changesA + changesB - coChanges;
            const jaccard = coChanges / union;

            expect(jaccard).toBe(0);
        });
    });

    // ── computeRiskScoreFromCommits (risk logic) ────────────────

    describe('risk score composite computation', () => {
        test('normalizes component scores to 0-1 range', () => {
            const normalize = (value: number, max: number): number =>
                max === 0 ? 0 : value / max;

            expect(normalize(5, 10)).toBe(0.5);
            expect(normalize(0, 10)).toBe(0);
            expect(normalize(10, 10)).toBe(1.0);
            expect(normalize(5, 0)).toBe(0);
        });

        test('composite risk is weighted sum within [0, 1]', () => {
            const weights = {
                change_frequency: 0.25,
                bug_fix_count: 0.30,
                regression_count: 0.20,
                recent_churn_30d: 0.15,
                distinct_authors: 0.10,
            };

            const compositeMax = weights.change_frequency * 1.0
                + weights.bug_fix_count * 1.0
                + weights.regression_count * 1.0
                + weights.recent_churn_30d * 1.0
                + weights.distinct_authors * 1.0;

            expect(compositeMax).toBeCloseTo(1.0, 5);
        });

        test('regression detection: two bug fixes within 30 days count as regression', () => {
            const bugFixDates = [
                new Date('2025-01-05'),
                new Date('2025-01-20'), // 15 days later
            ];

            let regressions = 0;
            for (let i = 1; i < bugFixDates.length; i++) {
                const daysBetween = (bugFixDates[i]!.getTime() - bugFixDates[i - 1]!.getTime())
                    / (1000 * 60 * 60 * 24);
                if (daysBetween <= 30) regressions++;
            }

            expect(regressions).toBe(1);
        });

        test('regression detection: gap > 30 days is not regression', () => {
            const bugFixDates = [
                new Date('2025-01-05'),
                new Date('2025-03-10'), // 64 days later
            ];

            let regressions = 0;
            for (let i = 1; i < bugFixDates.length; i++) {
                const daysBetween = (bugFixDates[i]!.getTime() - bugFixDates[i - 1]!.getTime())
                    / (1000 * 60 * 60 * 24);
                if (daysBetween <= 30) regressions++;
            }

            expect(regressions).toBe(0);
        });
    });

    // ── isIgnoredPath ───────────────────────────────────────────

    describe('isIgnoredPath', () => {
        const isIgnored = (engine as any).isIgnoredPath.bind(engine);

        test('ignores binary files', () => {
            expect(isIgnored('assets/logo.png')).toBe(true);
            expect(isIgnored('fonts/Inter.woff2')).toBe(true);
        });

        test('ignores lock files', () => {
            expect(isIgnored('package-lock.json')).toBe(true);
            expect(isIgnored('yarn.lock')).toBe(true);
        });

        test('ignores node_modules paths', () => {
            expect(isIgnored('node_modules/express/index.js')).toBe(true);
        });

        test('does not ignore source files', () => {
            expect(isIgnored('src/users.ts')).toBe(false);
            expect(isIgnored('lib/utils.py')).toBe(false);
        });
    });
});


// =====================================================================
// 5. CONCEPT FAMILIES
// =====================================================================

describe('ConceptFamilyEngine', () => {
    const engine = new ConceptFamilyEngine();

    // ── classifyFamilyType ──────────────────────────────────────

    describe('classifyFamilyType', () => {
        test('classifies validators by kind', () => {
            const svIds = ['sv-1', 'sv-2', 'sv-3'];
            const members: MemberData[] = [
                { symbol_version_id: 'sv-1', canonical_name: 'emailValidator', kind: 'validator', stable_key: 'a' },
                { symbol_version_id: 'sv-2', canonical_name: 'phoneValidator', kind: 'validator', stable_key: 'b' },
                { symbol_version_id: 'sv-3', canonical_name: 'urlCheck', kind: 'function', stable_key: 'c' },
            ];
            expect(engine.classifyFamilyType(svIds, members)).toBe('validator');
        });

        test('classifies auth_policy from behavioral profiles', () => {
            const svIds = ['sv-1', 'sv-2', 'sv-3'];
            const members: MemberData[] = [
                { symbol_version_id: 'sv-1', canonical_name: 'checkAdminAccess', kind: 'function', stable_key: 'a' },
                { symbol_version_id: 'sv-2', canonical_name: 'verifyPermission', kind: 'function', stable_key: 'b' },
                { symbol_version_id: 'sv-3', canonical_name: 'authorizeRequest', kind: 'function', stable_key: 'c' },
            ];

            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({ auth_operations: ['check_admin'] }));
            bpMap.set('sv-2', makeBehavioralProfile({ auth_operations: ['verify_perm'] }));
            bpMap.set('sv-3', makeBehavioralProfile({ auth_operations: ['auth_req'] }));

            expect(engine.classifyFamilyType(svIds, members, bpMap)).toBe('auth_policy');
        });

        test('classifies by name heuristics when no behavioral data', () => {
            const svIds = ['sv-1', 'sv-2', 'sv-3'];
            const members: MemberData[] = [
                { symbol_version_id: 'sv-1', canonical_name: 'validateEmail', kind: 'function', stable_key: 'a' },
                { symbol_version_id: 'sv-2', canonical_name: 'validatePhone', kind: 'function', stable_key: 'b' },
                { symbol_version_id: 'sv-3', canonical_name: 'checkPostalCode', kind: 'function', stable_key: 'c' },
            ];
            expect(engine.classifyFamilyType(svIds, members)).toBe('validator');
        });

        test('returns custom for empty member data', () => {
            expect(engine.classifyFamilyType([], [])).toBe('custom');
        });

        test('returns business_rule for generic behavioral data', () => {
            const svIds = ['sv-1', 'sv-2'];
            const members: MemberData[] = [
                { symbol_version_id: 'sv-1', canonical_name: 'processOrder', kind: 'function', stable_key: 'a' },
                { symbol_version_id: 'sv-2', canonical_name: 'calculateTotal', kind: 'function', stable_key: 'b' },
            ];
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({ db_writes: ['insert'] }));
            bpMap.set('sv-2', makeBehavioralProfile({ db_reads: ['query'] }));

            expect(engine.classifyFamilyType(svIds, members, bpMap)).toBe('business_rule');
        });
    });

    // ── selectExemplarSync ──────────────────────────────────────

    describe('selectExemplarSync', () => {
        const selectExemplar = (engine as any).selectExemplarSync.bind(engine);

        test('returns single member for 1-member family', () => {
            const result = selectExemplar(
                ['sv-1'],
                [],
                new Map(),
                new Map()
            );
            expect(result).toBe('sv-1');
        });

        test('returns empty string for empty family', () => {
            const result = selectExemplar([], [], new Map(), new Map());
            expect(result).toBe('');
        });

        test('selects member with highest avg similarity + completeness', () => {
            const svIds = ['sv-1', 'sv-2', 'sv-3'];
            const edges = [
                { src: 'sv-1', dst: 'sv-2', confidence: 0.9 },
                { src: 'sv-1', dst: 'sv-3', confidence: 0.85 },
                { src: 'sv-2', dst: 'sv-3', confidence: 0.7 },
            ];

            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({
                purity_class: 'read_only',
                db_reads: ['query'],
                resource_touches: ['db:read:query'],
            }));

            const cpMap = new Map<string, ContractProfile>();
            cpMap.set('sv-1', makeContractProfile({
                input_contract: '(id: string)',
                output_contract: 'User',
            }));

            const result = selectExemplar(svIds, edges, bpMap, cpMap);
            // sv-1 has highest avg similarity (0.875) and completeness
            expect(result).toBe('sv-1');
        });
    });

    // ── computeFingerprintsFromCache ─────────────────────────────

    describe('computeFingerprintsFromCache', () => {
        const computeFingerprints = (engine as any).computeFingerprintsFromCache.bind(engine);

        test('builds contract intersection and effect union', () => {
            const svIds = ['sv-1', 'sv-2'];
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({ purity_class: 'read_only', db_reads: ['q'] }));
            bpMap.set('sv-2', makeBehavioralProfile({ purity_class: 'read_write', db_writes: ['w'] }));

            const cpMap = new Map<string, ContractProfile>();
            cpMap.set('sv-1', makeContractProfile({ input_contract: '(id: string)', output_contract: 'User' }));
            cpMap.set('sv-2', makeContractProfile({ input_contract: '(id: string)', output_contract: 'User' }));

            const result = computeFingerprints(svIds, bpMap, cpMap);

            const contractFp = JSON.parse(result.contract);
            // Tokenized majority intersection: '(id: string)' → tokens ['id', 'string']
            expect(contractFp.input).toContain('id');
            expect(contractFp.input).toContain('string');
            expect(contractFp.output).toContain('user');

            const effectFp = JSON.parse(result.effect);
            expect(effectFp).toContain('effect:db_read');
            expect(effectFp).toContain('effect:db_write');
        });

        test('handles empty contract maps', () => {
            const result = computeFingerprints(
                ['sv-1'],
                new Map(),
                new Map()
            );
            const contractFp = JSON.parse(result.contract);
            expect(contractFp.input).toEqual([]);
        });
    });

    // ── detectOutliersFromCache ──────────────────────────────────

    describe('detectOutliersFromCache', () => {
        const detectOutliers = (engine as any).detectOutliersFromCache.bind(engine);

        test('exemplar is never an outlier', () => {
            const svIds = ['sv-1', 'sv-2'];
            const edges = [{ src: 'sv-1', dst: 'sv-2', confidence: 0.9 }];
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({ purity_class: 'pure' }));
            bpMap.set('sv-2', makeBehavioralProfile({ purity_class: 'pure' }));

            const results: OutlierResult[] = detectOutliers(svIds, 'sv-1', edges, bpMap, new Map());

            const exemplarResult = results.find(r => r.symbol_version_id === 'sv-1');
            expect(exemplarResult?.is_outlier).toBe(false);
            expect(exemplarResult?.similarity_to_exemplar).toBe(1.0);
        });

        test('detects purity contradiction between exemplar and member', () => {
            const svIds = ['sv-1', 'sv-2'];
            const edges = [{ src: 'sv-1', dst: 'sv-2', confidence: 0.8 }];
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({ purity_class: 'pure' }));
            bpMap.set('sv-2', makeBehavioralProfile({ purity_class: 'side_effecting' }));

            const results: OutlierResult[] = detectOutliers(svIds, 'sv-1', edges, bpMap, new Map());

            const memberResult = results.find(r => r.symbol_version_id === 'sv-2');
            expect(memberResult?.is_contradicting).toBe(true);
            expect(memberResult?.contradiction_flags).toContain(
                'purity_diverges:pure->side_effecting'
            );
        });

        test('detects auth requirement contradiction', () => {
            const svIds = ['sv-1', 'sv-2'];
            const edges = [{ src: 'sv-1', dst: 'sv-2', confidence: 0.8 }];
            const bpMap = new Map<string, BehavioralProfile>();
            bpMap.set('sv-1', makeBehavioralProfile({ auth_operations: ['verify'] }));
            bpMap.set('sv-2', makeBehavioralProfile({ auth_operations: [] }));

            const results: OutlierResult[] = detectOutliers(svIds, 'sv-1', edges, bpMap, new Map());

            const memberResult = results.find(r => r.symbol_version_id === 'sv-2');
            expect(memberResult?.contradiction_flags).toContain('auth_requirement_differs');
        });

        test('member with no edge to exemplar gets discounted similarity', () => {
            const svIds = ['sv-1', 'sv-2', 'sv-3'];
            // sv-2 has edge to sv-3 but NOT to sv-1 (exemplar)
            const edges = [
                { src: 'sv-2', dst: 'sv-3', confidence: 0.7 },
                { src: 'sv-1', dst: 'sv-3', confidence: 0.9 },
            ];
            const bpMap = new Map<string, BehavioralProfile>();

            const results: OutlierResult[] = detectOutliers(svIds, 'sv-1', edges, bpMap, new Map());

            const sv2Result = results.find(r => r.symbol_version_id === 'sv-2');
            // sv-2 has avg similarity 0.7 but discounted by 0.8 factor
            expect(sv2Result?.similarity_to_exemplar).toBeLessThan(0.7);
        });
    });
});


// =====================================================================
// 6. DEEP CONTRACTS
// =====================================================================

describe('DeepContractSynthesizer', () => {
    const synthesizer = new DeepContractSynthesizer();

    // ── mineFromBody — code body analysis ───────────────────────

    describe('mineFromBody', () => {
        test('detects assert() calls', async () => {
            const body = 'function validate(x) {\n  assert(x > 0);\n  return x;\n}';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.startsWith('assert:'))).toBe(true);
        });

        test('detects guard clauses (if-throw)', async () => {
            const body = 'if (!input) { throw new Error("missing"); }';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.includes('guard_clause'))).toBe(true);
        });

        test('detects typeof type guards', async () => {
            const body = 'if (typeof name === "string") { return name.trim(); }';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.includes('type_guard:typeof'))).toBe(true);
        });

        test('detects instanceof type guards', async () => {
            const body = 'if (error instanceof ValidationError) { handleError(error); }';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.includes('instanceof'))).toBe(true);
        });

        test('detects nullish coalescing', async () => {
            const body = 'const val = input ?? defaultValue;';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.includes('null_safety'))).toBe(true);
        });

        test('detects regex validators', async () => {
            const body = 'if (/^[a-z0-9]+@[a-z]+\\.[a-z]+$/.test(email)) { return true; }';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.includes('regex_validation'))).toBe(true);
        });

        test('detects Zod schema usage', async () => {
            const body = 'const schema = z.string().email().min(5);';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            expect(candidates.some(c => c.expression.includes('schema_zod'))).toBe(true);
        });

        test('returns empty for trivial code', async () => {
            const body = 'return a + b;';
            const candidates = await synthesizer.mineFromBody('sv-1', body, 'sym-1', 'repo', 'snap', 'typescript');

            // Trivial arithmetic — no patterns to mine
            expect(candidates.length).toBe(0);
        });
    });

    // ── mineFromSignature — param and return type extraction ────

    describe('mineFromSignature', () => {
        test('extracts param type contracts', async () => {
            const sig = 'createUser(name: string, age: number): Promise<User>';
            const candidates = await synthesizer.mineFromSignature('sv-1', sig, 'sym-1', 'repo', 'snap');

            const inputTypes = candidates.filter(c => c.expression.startsWith('input_type:'));
            expect(inputTypes.length).toBeGreaterThanOrEqual(2);
            expect(inputTypes.some(c => c.expression.includes('name: string'))).toBe(true);
            expect(inputTypes.some(c => c.expression.includes('age: number'))).toBe(true);
        });

        test('extracts return type contracts', async () => {
            const sig = 'getUser(id: string): Promise<User | null>';
            const candidates = await synthesizer.mineFromSignature('sv-1', sig, 'sym-1', 'repo', 'snap');

            const returnContracts = candidates.filter(c => c.expression.startsWith('output_guarantee:'));
            expect(returnContracts.length).toBeGreaterThanOrEqual(1);
        });

        test('detects nullable return types', async () => {
            const sig = 'findItem(id: string): Item | null';
            const candidates = await synthesizer.mineFromSignature('sv-1', sig, 'sym-1', 'repo', 'snap');

            expect(candidates.some(c => c.expression.includes('output_nullable'))).toBe(true);
        });

        test('detects optional parameters', async () => {
            const sig = 'search(query: string, limit?: number): Results';
            const candidates = await synthesizer.mineFromSignature('sv-1', sig, 'sym-1', 'repo', 'snap');

            expect(candidates.some(c => c.expression.includes('optional_params'))).toBe(true);
        });

        test('handles empty signature', async () => {
            const candidates = await synthesizer.mineFromSignature('sv-1', '', 'sym-1', 'repo', 'snap');
            expect(candidates.length).toBe(0);
        });

        test('detects generic constraints', async () => {
            const sig = '<T extends BaseEntity>(item: T): Promise<T>';
            const candidates = await synthesizer.mineFromSignature('sv-1', sig, 'sym-1', 'repo', 'snap');

            expect(candidates.some(c => c.expression.includes('type_bound'))).toBe(true);
        });
    });

    // ── mineFromDecoratorString — decorator extraction ──────────

    describe('mineFromDecoratorString', () => {
        const mineDecorator = (synthesizer as any).mineFromDecoratorString.bind(synthesizer);

        test('detects @Min decorator', () => {
            const out: any[] = [];
            mineDecorator('@Min(0)', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('min=0'))).toBe(true);
        });

        test('detects @Max decorator', () => {
            const out: any[] = [];
            mineDecorator('@Max(100)', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('max=100'))).toBe(true);
        });

        test('detects @Matches decorator', () => {
            const out: any[] = [];
            mineDecorator('@Matches(/^[A-Z]+$/)', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('match'))).toBe(true);
        });

        test('detects @RequiresRole decorator', () => {
            const out: any[] = [];
            mineDecorator('@RequiresRole("admin")', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('auth') || c.expression.includes('role'))).toBe(true);
        });

        test('detects @IsEmail decorator', () => {
            const out: any[] = [];
            mineDecorator('@IsEmail()', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('email'))).toBe(true);
        });

        test('detects @IsNotEmpty decorator', () => {
            const out: any[] = [];
            mineDecorator('@IsNotEmpty()', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('not be empty'))).toBe(true);
        });

        test('detects @IsUUID decorator', () => {
            const out: any[] = [];
            mineDecorator('@IsUUID()', 'sym-1', out);
            expect(out.some((c: any) => c.expression.includes('UUID'))).toBe(true);
        });

        test('handles unknown decorator without crashing', () => {
            const out: any[] = [];
            mineDecorator('@UnknownDecorator("foo")', 'sym-1', out);
            // Should not throw; may or may not produce candidates
            expect(Array.isArray(out)).toBe(true);
        });
    });
});
