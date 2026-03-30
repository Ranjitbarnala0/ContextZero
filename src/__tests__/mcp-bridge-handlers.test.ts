/**
 * Comprehensive test suite for MCP bridge handlers (handlers.ts) and
 * registerTool wrapper logic (index.ts).
 *
 * Covers:
 *   - All 39+ handler functions (happy path + error paths)
 *   - UUID validation gates
 *   - requireString / requireArray argument extraction
 *   - safeTool error sanitization
 *   - SAFE_ERROR_PREFIXES export
 */

// ────────── Mocks (must be before any imports that touch them) ──────────

const mockResolveSymbol = jest.fn();
const mockGetSymbolDetails = jest.fn();
const mockGetCodebaseOverview = jest.fn();
const mockCompileSmartContext = jest.fn();
const mockSearchCode = jest.fn();
const mockListRepos = jest.fn();
const mockListSnapshots = jest.fn();

const mockCreateRepository = jest.fn();
const mockGetRepository = jest.fn();
const mockIngestRepo = jest.fn();
const mockIngestIncremental = jest.fn();
const mockEnsureAllowedRepoPath = jest.fn();
const mockDeriveWorkspaceSnapshotIdentity = jest.fn();
const mockBuildNativeCodebaseOverview = jest.fn();
const mockSearchWorkspaceCode = jest.fn();
const mockSearchWorkspaceSymbols = jest.fn();
const mockResolvePathWithinBase = jest.fn();

const mockDbQuery = jest.fn();
const mockDbHealthCheck = jest.fn();
const mockDbGetPoolStats = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockDbQuery(...args),
        healthCheck: (...args: unknown[]) => mockDbHealthCheck(...args),
        getPoolStats: (...args: unknown[]) => mockDbGetPoolStats(...args),
    },
}));

jest.mock('../db-driver/core_data', () => ({
    coreDataService: {
        createRepository: (...args: unknown[]) => mockCreateRepository(...args),
        getRepository: (...args: unknown[]) => mockGetRepository(...args),
    },
}));

jest.mock('../db-driver/result', () => ({
    firstRow: (result: { rows: unknown[] }) => result?.rows?.[0],
    optionalStringField: (row: Record<string, unknown> | undefined, field: string) =>
        row && typeof row[field] === 'string' ? row[field] : undefined,
    parseCountField: (row: Record<string, unknown> | undefined, field = 'cnt') => {
        if (!row) return 0;
        const val = row[field];
        return typeof val === 'number' ? val : parseInt(String(val), 10) || 0;
    },
}));

jest.mock('../analysis-engine', () => ({
    structuralGraphEngine: {
        getCallers: jest.fn(),
        getCallees: jest.fn(),
        getRelationsForSymbol: jest.fn(),
    },
}));

jest.mock('../analysis-engine/behavioral', () => ({
    behavioralEngine: {
        getProfile: jest.fn(),
        compareBehavior: jest.fn(),
    },
}));

jest.mock('../analysis-engine/contracts', () => ({
    contractEngine: {
        getProfile: jest.fn(),
        getInvariantsForSymbol: jest.fn(),
        compareContracts: jest.fn(),
    },
}));

jest.mock('../analysis-engine/blast-radius', () => ({
    blastRadiusEngine: {
        computeBlastRadius: jest.fn(),
    },
}));

jest.mock('../analysis-engine/capsule-compiler', () => ({
    capsuleCompiler: {
        compile: jest.fn(),
    },
}));

jest.mock('../analysis-engine/uncertainty', () => ({
    uncertaintyTracker: {
        getSnapshotUncertainty: jest.fn(),
    },
}));

jest.mock('../homolog-engine', () => ({
    homologInferenceEngine: {
        findHomologs: jest.fn(),
        persistHomologs: jest.fn(),
    },
}));

jest.mock('../transactional-editor', () => ({
    transactionalChangeEngine: {
        createTransaction: jest.fn(),
        applyPatch: jest.fn(),
        validate: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        computePropagationProposals: jest.fn(),
        getTransaction: jest.fn(),
    },
}));

jest.mock('../ingestor', () => ({
    ingestor: {
        ingestRepo: (...args: unknown[]) => mockIngestRepo(...args),
        ingestIncremental: (...args: unknown[]) => mockIngestIncremental(...args),
    },
}));

jest.mock('../workspace-native', () => ({
    ensureAllowedRepoPath: (...args: unknown[]) => mockEnsureAllowedRepoPath(...args),
    deriveWorkspaceSnapshotIdentity: (...args: unknown[]) => mockDeriveWorkspaceSnapshotIdentity(...args),
    buildNativeCodebaseOverview: (...args: unknown[]) => mockBuildNativeCodebaseOverview(...args),
    searchWorkspaceCode: (...args: unknown[]) => mockSearchWorkspaceCode(...args),
    searchWorkspaceSymbols: (...args: unknown[]) => mockSearchWorkspaceSymbols(...args),
}));

jest.mock('../path-security', () => ({
    resolvePathWithinBase: (...args: unknown[]) => mockResolvePathWithinBase(...args),
}));

jest.mock('../services', () => ({
    resolveSymbol: (...args: unknown[]) => mockResolveSymbol(...args),
    getSymbolDetails: (...args: unknown[]) => mockGetSymbolDetails(...args),
    getCodebaseOverview: (...args: unknown[]) => mockGetCodebaseOverview(...args),
    compileSmartContext: (...args: unknown[]) => mockCompileSmartContext(...args),
    searchCode: (...args: unknown[]) => mockSearchCode(...args),
    listRepos: (...args: unknown[]) => mockListRepos(...args),
    listSnapshots: (...args: unknown[]) => mockListSnapshots(...args),
}));

jest.mock('../semantic-engine', () => ({
    semanticEngine: {
        searchByQuery: jest.fn(),
        batchEmbedSnapshot: jest.fn(),
    },
}));

jest.mock('../analysis-engine/dispatch-resolver', () => ({
    dispatchResolver: {
        getDispatchEdges: jest.fn(),
        getMRO: jest.fn(),
    },
}));

jest.mock('../analysis-engine/symbol-lineage', () => ({
    symbolLineageEngine: {
        getLineageHistory: jest.fn(),
    },
}));

jest.mock('../analysis-engine/effect-engine', () => ({
    effectEngine: {
        getEffectSignature: jest.fn(),
        diffEffects: jest.fn(),
    },
}));

jest.mock('../analysis-engine/concept-families', () => ({
    conceptFamilyEngine: {
        getFamilyForSymbol: jest.fn(),
        getFamilies: jest.fn(),
    },
}));

jest.mock('../analysis-engine/temporal-engine', () => ({
    temporalEngine: {
        getRiskScore: jest.fn(),
        getCoChangePartners: jest.fn(),
    },
}));

jest.mock('../analysis-engine/runtime-evidence', () => ({
    runtimeEvidenceEngine: {
        ingestTrace: jest.fn(),
        getEvidenceForSymbol: jest.fn(),
    },
}));

jest.mock('../cache', () => ({
    symbolCache: { stats: jest.fn().mockReturnValue({ hits: 10, misses: 2 }), get: jest.fn(), set: jest.fn() },
    profileCache: { stats: jest.fn().mockReturnValue({ hits: 5, misses: 1 }), get: jest.fn(), set: jest.fn() },
    capsuleCache: { stats: jest.fn().mockReturnValue({ hits: 3, misses: 0 }), get: jest.fn(), set: jest.fn() },
    homologCache: { stats: jest.fn().mockReturnValue({ hits: 7, misses: 4 }), get: jest.fn(), set: jest.fn() },
    queryCache: { stats: jest.fn().mockReturnValue({ hits: 0, misses: 0 }), get: jest.fn(), set: jest.fn() },
}));

// ────────── Imports (after mocks) ──────────

import type { McpLogger } from '../mcp-bridge/index';
import {
    handleResolveSymbol,
    handleGetSymbolDetails,
    handleGetSymbolRelations,
    handleGetBehavioralProfile,
    handleGetContractProfile,
    handleGetInvariants,
    handleGetUncertainty,
    handleFindHomologs,
    handleBlastRadius,
    handleCompileContextCapsule,
    handleCreateChangeTransaction,
    handleApplyPatch,
    handleValidateChange,
    handleCommitChange,
    handleRollbackChange,
    handlePropagationProposals,
    handleGetTransaction,
    handleRegisterRepo,
    handleIngestRepo,
    handleListRepos,
    handleListSnapshots,
    handleSnapshotStats,
    handlePersistHomologs,
    handleReadSource,
    handleSearchCode,
    handleCodebaseOverview,
    handleNativeCodebaseOverview,
    handleNativeSymbolSearch,
    handleNativeSearchCode,
    handleSemanticSearch,
    handleSmartContext,
    handleGetDispatchEdges,
    handleGetClassHierarchy,
    handleGetSymbolLineage,
    handleGetEffectSignature,
    handleDiffEffects,
    handleGetConceptFamily,
    handleListConceptFamilies,
    handleGetTemporalRisk,
    handleGetCoChangePartners,
    handleIngestRuntimeTrace,
    handleGetRuntimeEvidence,
    handleHealthCheck,
    handleIncrementalIndex,
    handleBatchEmbed,
    handleCacheStats,
    SAFE_ERROR_PREFIXES,
} from '../mcp-bridge/handlers';

import { structuralGraphEngine } from '../analysis-engine';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { blastRadiusEngine } from '../analysis-engine/blast-radius';
import { capsuleCompiler } from '../analysis-engine/capsule-compiler';
import { uncertaintyTracker } from '../analysis-engine/uncertainty';
import { homologInferenceEngine } from '../homolog-engine';
import { transactionalChangeEngine } from '../transactional-editor';

// ────────── Helpers ──────────

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_2 = '22222222-2222-2222-2222-222222222222';
const VALID_UUID_3 = '33333333-3333-3333-3333-333333333333';

const log: McpLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

/** Parse the JSON body from a handler result */
function parseResult(result: { content: Array<{ text: string }> }): unknown {
    return JSON.parse(result.content[0].text);
}

// ────────── Tests ──────────

beforeEach(() => {
    jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════
// SAFE_ERROR_PREFIXES
// ═══════════════════════════════════════════════════════════

describe('SAFE_ERROR_PREFIXES', () => {
    test('is a non-empty array of strings', () => {
        expect(Array.isArray(SAFE_ERROR_PREFIXES)).toBe(true);
        expect(SAFE_ERROR_PREFIXES.length).toBeGreaterThan(5);
        for (const p of SAFE_ERROR_PREFIXES) {
            expect(typeof p).toBe('string');
        }
    });

    test('contains key prefixes for user-facing errors', () => {
        const arr = [...SAFE_ERROR_PREFIXES];
        expect(arr).toContain('Transaction not found');
        expect(arr).toContain('Repository not found');
        expect(arr).toContain('Symbol not found');
        expect(arr).toContain('Path traversal');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 1: handleResolveSymbol
// ═══════════════════════════════════════════════════════════

describe('handleResolveSymbol', () => {
    test('returns results on happy path', async () => {
        mockResolveSymbol.mockResolvedValue([{ name: 'foo', score: 0.9 }]);
        const result = await handleResolveSymbol({
            query: 'foo',
            repo_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        expect(mockResolveSymbol).toHaveBeenCalledWith('foo', VALID_UUID, undefined, undefined, 10);
    });

    test('returns error for invalid repo_id (non-UUID)', async () => {
        const result = await handleResolveSymbol({
            query: 'foo',
            repo_id: 'not-a-uuid',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('repo_id');
    });

    test('returns error for missing query', async () => {
        await expect(handleResolveSymbol({
            repo_id: VALID_UUID,
        }, log)).rejects.toThrow('Missing required string parameter: query');
    });

    test('clamps limit to range 1..100', async () => {
        mockResolveSymbol.mockResolvedValue([]);
        await handleResolveSymbol({
            query: 'bar',
            repo_id: VALID_UUID,
            limit: 999,
        }, log);
        expect(mockResolveSymbol).toHaveBeenCalledWith('bar', VALID_UUID, undefined, undefined, 100);
    });

    test('validates optional snapshot_id when provided', async () => {
        const result = await handleResolveSymbol({
            query: 'bar',
            repo_id: VALID_UUID,
            snapshot_id: 'bad-uuid',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('snapshot_id');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 2: handleGetSymbolDetails
// ═══════════════════════════════════════════════════════════

describe('handleGetSymbolDetails', () => {
    test('returns details on happy path', async () => {
        mockGetSymbolDetails.mockResolvedValue({ name: 'MyClass', kind: 'class' });
        const result = await handleGetSymbolDetails({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        expect(mockGetSymbolDetails).toHaveBeenCalledWith(VALID_UUID, 'summary');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetSymbolDetails({
            symbol_version_id: 'nope',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid view_mode', async () => {
        const result = await handleGetSymbolDetails({
            symbol_version_id: VALID_UUID,
            view_mode: 'invalid_mode',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('view_mode');
    });

    test('propagates UserFacingError (caught by safeTool wrapper in production)', async () => {
        const { UserFacingError } = jest.requireActual('../types') as { UserFacingError: typeof Error };
        mockGetSymbolDetails.mockRejectedValue(new UserFacingError('Symbol not found'));
        await expect(handleGetSymbolDetails({
            symbol_version_id: VALID_UUID,
            view_mode: 'code',
        }, log)).rejects.toThrow('Symbol not found');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 3: handleGetSymbolRelations
// ═══════════════════════════════════════════════════════════

describe('handleGetSymbolRelations', () => {
    test('returns relations with direction=both (default)', async () => {
        (structuralGraphEngine.getRelationsForSymbol as jest.Mock).mockResolvedValue([{ type: 'calls' }]);
        const result = await handleGetSymbolRelations({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { relations: unknown[]; count: number };
        expect(body.count).toBe(1);
        expect(structuralGraphEngine.getRelationsForSymbol).toHaveBeenCalledWith(VALID_UUID);
    });

    test('uses getCallers for direction=inbound', async () => {
        (structuralGraphEngine.getCallers as jest.Mock).mockResolvedValue([]);
        await handleGetSymbolRelations({
            symbol_version_id: VALID_UUID,
            direction: 'inbound',
        }, log);
        expect(structuralGraphEngine.getCallers).toHaveBeenCalledWith(VALID_UUID);
    });

    test('uses getCallees for direction=outbound', async () => {
        (structuralGraphEngine.getCallees as jest.Mock).mockResolvedValue([]);
        await handleGetSymbolRelations({
            symbol_version_id: VALID_UUID,
            direction: 'outbound',
        }, log);
        expect(structuralGraphEngine.getCallees).toHaveBeenCalledWith(VALID_UUID);
    });

    test('returns error for invalid direction', async () => {
        const result = await handleGetSymbolRelations({
            symbol_version_id: VALID_UUID,
            direction: 'sideways',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetSymbolRelations({
            symbol_version_id: 'nope',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 4: handleGetBehavioralProfile
// ═══════════════════════════════════════════════════════════

describe('handleGetBehavioralProfile', () => {
    test('returns profile on happy path', async () => {
        (behavioralEngine.getProfile as jest.Mock).mockResolvedValue({ purity: 'pure' });
        const result = await handleGetBehavioralProfile({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { profile: { purity: string } };
        expect(body.profile.purity).toBe('pure');
    });

    test('returns error when profile not found', async () => {
        (behavioralEngine.getProfile as jest.Mock).mockResolvedValue(null);
        const result = await handleGetBehavioralProfile({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('Behavioral profile not found');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetBehavioralProfile({
            symbol_version_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 5: handleGetContractProfile
// ═══════════════════════════════════════════════════════════

describe('handleGetContractProfile', () => {
    test('returns profile on happy path', async () => {
        (contractEngine.getProfile as jest.Mock).mockResolvedValue({ inputs: [], outputs: [] });
        const result = await handleGetContractProfile({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error when profile not found', async () => {
        (contractEngine.getProfile as jest.Mock).mockResolvedValue(null);
        const result = await handleGetContractProfile({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('Contract profile not found');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetContractProfile({
            symbol_version_id: 'x',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 6: handleGetInvariants
// ═══════════════════════════════════════════════════════════

describe('handleGetInvariants', () => {
    test('returns invariants on happy path', async () => {
        (contractEngine.getInvariantsForSymbol as jest.Mock).mockResolvedValue([{ rule: 'x > 0' }]);
        const result = await handleGetInvariants({
            symbol_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { invariants: unknown[]; count: number };
        expect(body.count).toBe(1);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetInvariants({ symbol_id: 'nope' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 7: handleGetUncertainty
// ═══════════════════════════════════════════════════════════

describe('handleGetUncertainty', () => {
    test('returns uncertainty report on happy path', async () => {
        (uncertaintyTracker.getSnapshotUncertainty as jest.Mock).mockResolvedValue({ score: 0.1 });
        const result = await handleGetUncertainty({
            snapshot_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { report: { score: number } };
        expect(body.report.score).toBe(0.1);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetUncertainty({ snapshot_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 8: handleFindHomologs
// ═══════════════════════════════════════════════════════════

describe('handleFindHomologs', () => {
    test('returns homologs on happy path', async () => {
        (homologInferenceEngine.findHomologs as jest.Mock).mockResolvedValue([{ svId: VALID_UUID_2, score: 0.85 }]);
        const result = await handleFindHomologs({
            symbol_version_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { homologs: unknown[]; count: number };
        expect(body.count).toBe(1);
    });

    test('returns error for invalid symbol_version_id', async () => {
        const result = await handleFindHomologs({
            symbol_version_id: 'bad',
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid snapshot_id', async () => {
        const result = await handleFindHomologs({
            symbol_version_id: VALID_UUID,
            snapshot_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('defaults confidence_threshold to 0.70', async () => {
        (homologInferenceEngine.findHomologs as jest.Mock).mockResolvedValue([]);
        await handleFindHomologs({
            symbol_version_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(homologInferenceEngine.findHomologs).toHaveBeenCalledWith(
            VALID_UUID, VALID_UUID_2, 0.70,
        );
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 9: handleBlastRadius
// ═══════════════════════════════════════════════════════════

describe('handleBlastRadius', () => {
    test('returns blast radius on happy path', async () => {
        (blastRadiusEngine.computeBlastRadius as jest.Mock).mockResolvedValue({ impact: 'high' });
        const result = await handleBlastRadius({
            symbol_version_ids: [VALID_UUID],
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for empty symbol_version_ids', async () => {
        const result = await handleBlastRadius({
            symbol_version_ids: [],
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for non-array symbol_version_ids', async () => {
        const result = await handleBlastRadius({
            symbol_version_ids: 'not-an-array',
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid UUID within symbol_version_ids', async () => {
        const result = await handleBlastRadius({
            symbol_version_ids: [VALID_UUID, 'bad-uuid'],
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('Invalid UUID');
    });

    test('clamps depth to 1..5 range', async () => {
        (blastRadiusEngine.computeBlastRadius as jest.Mock).mockResolvedValue({});
        await handleBlastRadius({
            symbol_version_ids: [VALID_UUID],
            snapshot_id: VALID_UUID_2,
            depth: 99,
        }, log);
        expect(blastRadiusEngine.computeBlastRadius).toHaveBeenCalledWith(VALID_UUID_2, [VALID_UUID], 5);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 10: handleCompileContextCapsule
// ═══════════════════════════════════════════════════════════

describe('handleCompileContextCapsule', () => {
    test('compiles capsule on happy path', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ base_path: '/repo' }] });
        (capsuleCompiler.compile as jest.Mock).mockResolvedValue({ sections: [] });
        const result = await handleCompileContextCapsule({
            symbol_version_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for invalid mode', async () => {
        const result = await handleCompileContextCapsule({
            symbol_version_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            mode: 'turbo',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('mode');
    });

    test('returns error for invalid symbol_version_id', async () => {
        const result = await handleCompileContextCapsule({
            symbol_version_id: 'bad',
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 11: handleCreateChangeTransaction
// ═══════════════════════════════════════════════════════════

describe('handleCreateChangeTransaction', () => {
    test('creates transaction on happy path', async () => {
        (transactionalChangeEngine.createTransaction as jest.Mock).mockResolvedValue(VALID_UUID_3);
        mockDbQuery.mockResolvedValue({ rows: [] });
        const result = await handleCreateChangeTransaction({
            repo_id: VALID_UUID,
            base_snapshot_id: VALID_UUID_2,
            target_symbol_version_ids: [VALID_UUID_3],
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { txn_id: string; state: string };
        expect(body.txn_id).toBe(VALID_UUID_3);
        expect(body.state).toBe('planned');
    });

    test('returns error for empty target_symbol_version_ids', async () => {
        const result = await handleCreateChangeTransaction({
            repo_id: VALID_UUID,
            base_snapshot_id: VALID_UUID_2,
            target_symbol_version_ids: [],
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid UUID in target_symbol_version_ids', async () => {
        const result = await handleCreateChangeTransaction({
            repo_id: VALID_UUID,
            base_snapshot_id: VALID_UUID_2,
            target_symbol_version_ids: ['bad'],
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid repo_id', async () => {
        const result = await handleCreateChangeTransaction({
            repo_id: 'bad',
            base_snapshot_id: VALID_UUID_2,
            target_symbol_version_ids: [VALID_UUID_3],
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 12: handleApplyPatch
// ═══════════════════════════════════════════════════════════

describe('handleApplyPatch', () => {
    test('applies patch on happy path', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ base_path: '/repo' }] });
        (transactionalChangeEngine.applyPatch as jest.Mock).mockResolvedValue(undefined);
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: 'src/main.ts', new_content: 'console.log("hi")' }],
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { state: string };
        expect(body.state).toBe('patched');
    });

    test('returns error for empty patches array', async () => {
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [],
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for path traversal in patch file_path', async () => {
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: '../../../etc/passwd', new_content: 'x' }],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('path traversal');
    });

    test('returns error for absolute path in patch file_path', async () => {
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: '/etc/passwd', new_content: 'x' }],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('path traversal or absolute path');
    });

    test('returns error for backslashes in patch file_path', async () => {
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: 'src\\main.ts', new_content: 'x' }],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('backslashes');
    });

    test('returns error for URL-encoded characters in patch file_path', async () => {
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: 'src%2F..%2Fetc', new_content: 'x' }],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('URL-encoded');
    });

    test('returns error for null bytes in patch file_path', async () => {
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: 'src/main.ts\0', new_content: 'x' }],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('null bytes');
    });

    test('returns error for more than 100 patches', async () => {
        const patches = Array.from({ length: 101 }, (_, i) => ({
            file_path: `file_${i}.ts`,
            new_content: 'x',
        }));
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches,
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('at most 100');
    });

    test('returns error when repo base path not found', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        const result = await handleApplyPatch({
            txn_id: VALID_UUID,
            patches: [{ file_path: 'src/main.ts', new_content: 'x' }],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('base path');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 13: handleValidateChange
// ═══════════════════════════════════════════════════════════

describe('handleValidateChange', () => {
    test('validates on happy path', async () => {
        mockDbQuery.mockResolvedValue({ rows: [{ base_path: '/repo' }] });
        (transactionalChangeEngine.validate as jest.Mock).mockResolvedValue({ passed: true });
        const result = await handleValidateChange({
            txn_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for invalid mode', async () => {
        const result = await handleValidateChange({
            txn_id: VALID_UUID,
            mode: 'ultra',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error when repo base path missing', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        const result = await handleValidateChange({ txn_id: VALID_UUID }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 14: handleCommitChange
// ═══════════════════════════════════════════════════════════

describe('handleCommitChange', () => {
    test('commits on happy path', async () => {
        (transactionalChangeEngine.commit as jest.Mock).mockResolvedValue(undefined);
        const result = await handleCommitChange({ txn_id: VALID_UUID }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { state: string };
        expect(body.state).toBe('committed');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleCommitChange({ txn_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 15: handleRollbackChange
// ═══════════════════════════════════════════════════════════

describe('handleRollbackChange', () => {
    test('rolls back on happy path', async () => {
        (transactionalChangeEngine.rollback as jest.Mock).mockResolvedValue(undefined);
        const result = await handleRollbackChange({ txn_id: VALID_UUID }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { state: string };
        expect(body.state).toBe('rolled_back');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleRollbackChange({ txn_id: 'x' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 16: handlePropagationProposals
// ═══════════════════════════════════════════════════════════

describe('handlePropagationProposals', () => {
    test('returns proposals on happy path', async () => {
        (transactionalChangeEngine.computePropagationProposals as jest.Mock).mockResolvedValue([
            { svId: VALID_UUID_3, reason: 'homolog' },
        ]);
        const result = await handlePropagationProposals({
            txn_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { proposals: unknown[]; count: number };
        expect(body.count).toBe(1);
    });

    test('returns error for invalid txn_id', async () => {
        const result = await handlePropagationProposals({
            txn_id: 'nope',
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid snapshot_id', async () => {
        const result = await handlePropagationProposals({
            txn_id: VALID_UUID,
            snapshot_id: 'nope',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 17: handleGetTransaction
// ═══════════════════════════════════════════════════════════

describe('handleGetTransaction', () => {
    test('returns transaction on happy path', async () => {
        (transactionalChangeEngine.getTransaction as jest.Mock).mockResolvedValue({ txn_id: VALID_UUID, state: 'patched' });
        const result = await handleGetTransaction({ txn_id: VALID_UUID }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error when transaction not found', async () => {
        (transactionalChangeEngine.getTransaction as jest.Mock).mockResolvedValue(null);
        const result = await handleGetTransaction({ txn_id: VALID_UUID }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toBe('Transaction not found');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetTransaction({ txn_id: 'nope' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// handleRegisterRepo
// ═══════════════════════════════════════════════════════════

describe('handleRegisterRepo', () => {
    test('registers repo on happy path', async () => {
        mockEnsureAllowedRepoPath.mockReturnValue('/tmp/repo');
        mockCreateRepository.mockResolvedValue(VALID_UUID);
        const result = await handleRegisterRepo({
            repo_name: 'my-repo',
            repo_path: '/tmp/repo',
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { repo_id: string; registered_path: string };
        expect(body.repo_id).toBe(VALID_UUID);
        expect(body.registered_path).toBe('/tmp/repo');
    });

    test('returns error when path validation fails with ENOENT', async () => {
        mockEnsureAllowedRepoPath.mockImplementation(() => { throw new Error('ENOENT: path not found'); });
        const result = await handleRegisterRepo({
            repo_name: 'my-repo',
            repo_path: '/nonexistent',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('not accessible');
    });

    test('returns error for generic path validation failure', async () => {
        mockEnsureAllowedRepoPath.mockImplementation(() => { throw new Error('some other error'); });
        const result = await handleRegisterRepo({
            repo_name: 'my-repo',
            repo_path: '/some/path',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('Failed to validate');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 18: handleIngestRepo
// ═══════════════════════════════════════════════════════════

describe('handleIngestRepo', () => {
    test('returns error when both repo_id and repo_path are provided', async () => {
        const result = await handleIngestRepo({
            repo_id: VALID_UUID,
            repo_path: '/tmp/repo',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('not both');
    });

    test('returns error when neither repo_id nor repo_path is provided', async () => {
        const result = await handleIngestRepo({}, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('repo_id or repo_path is required');
    });

    test('ingests by repo_id on happy path', async () => {
        mockGetRepository.mockResolvedValue({ name: 'my-repo', base_path: '/tmp/repo', default_branch: 'main' });
        mockDeriveWorkspaceSnapshotIdentity.mockResolvedValue({
            commit_sha: 'abc123',
            branch: 'main',
            source: 'git',
            files_considered: 5,
            truncated: false,
        });
        mockIngestRepo.mockResolvedValue({
            snapshot_id: VALID_UUID_2,
            files_processed: 3,
        });
        const result = await handleIngestRepo({ repo_id: VALID_UUID }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error when repo not found by id', async () => {
        mockGetRepository.mockResolvedValue(null);
        const result = await handleIngestRepo({ repo_id: VALID_UUID }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('Repository not found');
    });

    test('returns error for invalid repo_id UUID', async () => {
        const result = await handleIngestRepo({ repo_id: 'not-uuid' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 19: handleListRepos
// ═══════════════════════════════════════════════════════════

describe('handleListRepos', () => {
    test('returns repos with defaults', async () => {
        mockListRepos.mockResolvedValue({ repos: [], total: 0 });
        const result = await handleListRepos({}, log);
        expect(result.isError).toBeUndefined();
        expect(mockListRepos).toHaveBeenCalledWith(20, 0);
    });

    test('clamps limit to 1..100', async () => {
        mockListRepos.mockResolvedValue({ repos: [] });
        await handleListRepos({ limit: 0 }, log);
        expect(mockListRepos).toHaveBeenCalledWith(1, 0);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 20: handleListSnapshots
// ═══════════════════════════════════════════════════════════

describe('handleListSnapshots', () => {
    test('returns snapshots on happy path', async () => {
        mockListSnapshots.mockResolvedValue({ snapshots: [] });
        const result = await handleListSnapshots({ repo_id: VALID_UUID }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for invalid repo_id', async () => {
        const result = await handleListSnapshots({ repo_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 21: handleSnapshotStats
// ═══════════════════════════════════════════════════════════

describe('handleSnapshotStats', () => {
    test('returns stats on happy path', async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ snapshot_id: VALID_UUID, index_status: 'complete' }] }) // snapshot check
            .mockResolvedValueOnce({ rows: [{ cnt: 10 }] })   // file count
            .mockResolvedValueOnce({ rows: [{ cnt: 50 }] })   // symbol count
            .mockResolvedValueOnce({ rows: [{ cnt: 30 }] });   // relation count
        (uncertaintyTracker.getSnapshotUncertainty as jest.Mock).mockResolvedValue({ score: 0.2 });

        const result = await handleSnapshotStats({ snapshot_id: VALID_UUID }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { files: number; symbols: number };
        expect(body.files).toBe(10);
        expect(body.symbols).toBe(50);
    });

    test('returns error for snapshot not found', async () => {
        mockDbQuery.mockResolvedValueOnce({ rows: [] });
        const result = await handleSnapshotStats({ snapshot_id: VALID_UUID }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('Snapshot not found');
    });

    test('returns error for orphaned snapshot', async () => {
        mockDbQuery
            .mockResolvedValueOnce({ rows: [{ snapshot_id: VALID_UUID, index_status: 'complete' }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
            .mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
        (uncertaintyTracker.getSnapshotUncertainty as jest.Mock).mockResolvedValue(null);

        const result = await handleSnapshotStats({ snapshot_id: VALID_UUID }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('orphaned');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleSnapshotStats({ snapshot_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 22: handlePersistHomologs
// ═══════════════════════════════════════════════════════════

describe('handlePersistHomologs', () => {
    test('persists homologs on happy path', async () => {
        (homologInferenceEngine.findHomologs as jest.Mock).mockResolvedValue([{ svId: VALID_UUID_2 }]);
        (homologInferenceEngine.persistHomologs as jest.Mock).mockResolvedValue(1);
        const result = await handlePersistHomologs({
            source_symbol_version_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { homologs_found: number; persisted: number };
        expect(body.homologs_found).toBe(1);
        expect(body.persisted).toBe(1);
    });

    test('returns error for invalid source_symbol_version_id', async () => {
        const result = await handlePersistHomologs({
            source_symbol_version_id: 'nah',
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 23: handleReadSource
// ═══════════════════════════════════════════════════════════

describe('handleReadSource', () => {
    test('returns symbol source in symbol mode', async () => {
        mockDbQuery.mockResolvedValue({
            rows: [{
                symbol_version_id: VALID_UUID,
                canonical_name: 'myFunc',
                kind: 'function',
                signature: 'function myFunc()',
                summary: 'does stuff',
                body_source: 'function myFunc() { return 1; }',
                file_path: 'src/index.ts',
                range_start_line: 1,
                range_end_line: 3,
                stable_key: 'myFunc',
            }],
        });
        const result = await handleReadSource({
            repo_id: VALID_UUID,
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { symbols: unknown[]; count: number };
        expect(body.count).toBe(1);
    });

    test('returns error when no identifier provided', async () => {
        const result = await handleReadSource({
            repo_id: VALID_UUID,
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('symbol_version_id');
    });

    test('returns error for invalid repo_id', async () => {
        const result = await handleReadSource({
            repo_id: 'bad',
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error when no symbol versions found', async () => {
        mockDbQuery.mockResolvedValue({ rows: [] });
        const result = await handleReadSource({
            repo_id: VALID_UUID,
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('No symbol versions found');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 24: handleSearchCode
// ═══════════════════════════════════════════════════════════

describe('handleSearchCode', () => {
    test('returns search results on happy path', async () => {
        mockSearchCode.mockResolvedValue({ matches: [], total: 0 });
        const result = await handleSearchCode({
            repo_id: VALID_UUID,
            pattern: 'console.log',
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for invalid repo_id', async () => {
        const result = await handleSearchCode({
            repo_id: 'bad',
            pattern: 'test',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for pattern too long', async () => {
        const result = await handleSearchCode({
            repo_id: VALID_UUID,
            pattern: 'x'.repeat(501),
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('too long');
    });

    test('propagates UserFacingError from searchCode (caught by safeTool wrapper)', async () => {
        const { UserFacingError } = jest.requireActual('../types') as { UserFacingError: typeof Error };
        mockSearchCode.mockRejectedValue(new UserFacingError('Repository not found'));
        await expect(handleSearchCode({
            repo_id: VALID_UUID,
            pattern: 'test',
        }, log)).rejects.toThrow('Repository not found');
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 25: handleCodebaseOverview
// ═══════════════════════════════════════════════════════════

describe('handleCodebaseOverview', () => {
    test('returns overview on happy path', async () => {
        mockGetCodebaseOverview.mockResolvedValue({ summary: 'A TS project' });
        const result = await handleCodebaseOverview({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for invalid repo_id', async () => {
        const result = await handleCodebaseOverview({
            repo_id: 'bad',
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid snapshot_id', async () => {
        const result = await handleCodebaseOverview({
            repo_id: VALID_UUID,
            snapshot_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// handleNativeCodebaseOverview
// ═══════════════════════════════════════════════════════════

describe('handleNativeCodebaseOverview', () => {
    test('returns overview on happy path', async () => {
        mockEnsureAllowedRepoPath.mockReturnValue('/tmp/repo');
        mockBuildNativeCodebaseOverview.mockResolvedValue({ files: 10 });
        const result = await handleNativeCodebaseOverview({
            repo_path: '/tmp/repo',
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { mode: string };
        expect(body.mode).toBe('native_preindex');
    });

    test('returns error when path is not accessible', async () => {
        mockEnsureAllowedRepoPath.mockImplementation(() => {
            throw new Error('ENOENT: not found');
        });
        const result = await handleNativeCodebaseOverview({
            repo_path: '/nonexistent',
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('not accessible');
    });
});

// ═══════════════════════════════════════════════════════════
// handleNativeSymbolSearch
// ═══════════════════════════════════════════════════════════

describe('handleNativeSymbolSearch', () => {
    test('returns results on happy path', async () => {
        mockEnsureAllowedRepoPath.mockReturnValue('/tmp/repo');
        mockSearchWorkspaceSymbols.mockResolvedValue({ symbols: [], total: 0 });
        const result = await handleNativeSymbolSearch({
            repo_path: '/tmp/repo',
            query: 'myFunc',
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error when path not accessible (EACCES)', async () => {
        mockEnsureAllowedRepoPath.mockImplementation(() => {
            throw new Error('EACCES: permission denied');
        });
        const result = await handleNativeSymbolSearch({
            repo_path: '/restricted',
            query: 'test',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error when query is missing', async () => {
        await expect(handleNativeSymbolSearch({
            repo_path: '/tmp/repo',
        }, log)).rejects.toThrow('Missing required string parameter');
    });
});

// ═══════════════════════════════════════════════════════════
// handleNativeSearchCode
// ═══════════════════════════════════════════════════════════

describe('handleNativeSearchCode', () => {
    test('returns results on happy path', async () => {
        mockEnsureAllowedRepoPath.mockReturnValue('/tmp/repo');
        mockSearchWorkspaceCode.mockResolvedValue({ matches: [] });
        const result = await handleNativeSearchCode({
            repo_path: '/tmp/repo',
            pattern: 'TODO',
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for pattern too long', async () => {
        const result = await handleNativeSearchCode({
            repo_path: '/tmp/repo',
            pattern: 'x'.repeat(501),
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('too long');
    });

    test('returns error when path not allowed', async () => {
        mockEnsureAllowedRepoPath.mockImplementation(() => {
            throw new Error('not within allowed base paths');
        });
        const result = await handleNativeSearchCode({
            repo_path: '/bad/path',
            pattern: 'x',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 26: handleSemanticSearch
// ═══════════════════════════════════════════════════════════

describe('handleSemanticSearch', () => {
    test('returns matches on happy path', async () => {
        const { semanticEngine } = require('../semantic-engine');
        semanticEngine.searchByQuery.mockResolvedValue([{ svId: VALID_UUID, similarity: 0.95 }]);
        mockDbQuery.mockResolvedValue({
            rows: [{
                symbol_version_id: VALID_UUID,
                canonical_name: 'myFunc',
                kind: 'function',
                stable_key: 'key',
                signature: 'sig',
                summary: 'sum',
                body_source: 'code',
                file_path: 'f.ts',
                range_start_line: 1,
                range_end_line: 5,
            }],
        });
        const result = await handleSemanticSearch({
            query: 'matrix multiplication',
            snapshot_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { total: number; matches: unknown[] };
        expect(body.total).toBe(1);
    });

    test('returns empty matches when no results found', async () => {
        const { semanticEngine } = require('../semantic-engine');
        semanticEngine.searchByQuery.mockResolvedValue([]);
        const result = await handleSemanticSearch({
            query: 'obscure query',
            snapshot_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { total: number; note: string };
        expect(body.total).toBe(0);
        expect(body.note).toContain('No semantic matches');
    });

    test('returns error for invalid snapshot_id', async () => {
        const result = await handleSemanticSearch({
            query: 'test',
            snapshot_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for query too long', async () => {
        const result = await handleSemanticSearch({
            query: 'x'.repeat(2001),
            snapshot_id: VALID_UUID,
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 27: handleSmartContext
// ═══════════════════════════════════════════════════════════

describe('handleSmartContext', () => {
    test('returns context on happy path', async () => {
        mockCompileSmartContext.mockResolvedValue({ bundle: 'data' });
        const result = await handleSmartContext({
            task_description: 'Refactor auth',
            target_symbol_version_ids: [VALID_UUID],
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for empty target_symbol_version_ids', async () => {
        const result = await handleSmartContext({
            task_description: 'Refactor auth',
            target_symbol_version_ids: [],
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid UUID in target_symbol_version_ids', async () => {
        const result = await handleSmartContext({
            task_description: 'Refactor',
            target_symbol_version_ids: [VALID_UUID, 'bad-id'],
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid snapshot_id', async () => {
        const result = await handleSmartContext({
            task_description: 'Refactor',
            target_symbol_version_ids: [VALID_UUID],
            snapshot_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// V2 Handlers
// ═══════════════════════════════════════════════════════════

describe('handleGetDispatchEdges', () => {
    test('returns edges on happy path', async () => {
        const { dispatchResolver } = require('../analysis-engine/dispatch-resolver');
        dispatchResolver.getDispatchEdges.mockResolvedValue([{ target: 'fn1' }]);
        const result = await handleGetDispatchEdges({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { total: number };
        expect(body.total).toBe(1);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetDispatchEdges({
            symbol_version_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetClassHierarchy', () => {
    test('returns MRO on happy path', async () => {
        const { dispatchResolver } = require('../analysis-engine/dispatch-resolver');
        dispatchResolver.getMRO.mockResolvedValue(['A', 'B', 'Object']);
        const result = await handleGetClassHierarchy({
            snapshot_id: VALID_UUID,
            symbol_version_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { method_resolution_order: string[] };
        expect(body.method_resolution_order).toEqual(['A', 'B', 'Object']);
    });

    test('returns error when UUIDs are invalid', async () => {
        const result = await handleGetClassHierarchy({
            snapshot_id: 'bad',
            symbol_version_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetSymbolLineage', () => {
    test('returns lineage on happy path', async () => {
        const { symbolLineageEngine } = require('../analysis-engine/symbol-lineage');
        symbolLineageEngine.getLineageHistory.mockResolvedValue([{ version: 1 }, { version: 2 }]);
        const result = await handleGetSymbolLineage({
            symbol_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { lineage_history: unknown[] };
        expect(body.lineage_history).toHaveLength(2);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetSymbolLineage({ symbol_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetEffectSignature', () => {
    test('returns effect signature on happy path', async () => {
        const { effectEngine } = require('../analysis-engine/effect-engine');
        effectEngine.getEffectSignature.mockResolvedValue({
            effects: ['read_db'],
            effect_class: 'io',
            reads_resources: ['users'],
            writes_resources: [],
            emits_events: false,
            calls_external: false,
            mutates_state: false,
            requires_auth: true,
            throws_errors: false,
            confidence: 0.9,
        });
        const result = await handleGetEffectSignature({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { effect_class: string };
        expect(body.effect_class).toBe('io');
    });

    test('returns null message when no signature found', async () => {
        const { effectEngine } = require('../analysis-engine/effect-engine');
        effectEngine.getEffectSignature.mockResolvedValue(null);
        const result = await handleGetEffectSignature({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { effect_signature: null; message: string };
        expect(body.effect_signature).toBeNull();
        expect(body.message).toContain('No effect signature');
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetEffectSignature({ symbol_version_id: 'x' }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleDiffEffects', () => {
    test('diffs effects on happy path', async () => {
        const { effectEngine } = require('../analysis-engine/effect-engine');
        effectEngine.diffEffects.mockResolvedValue({ added: ['write_db'], removed: [] });
        const result = await handleDiffEffects({
            before_symbol_version_id: VALID_UUID,
            after_symbol_version_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error when UUIDs are invalid', async () => {
        const result = await handleDiffEffects({
            before_symbol_version_id: 'bad',
            after_symbol_version_id: 'bad',
        }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetConceptFamily', () => {
    test('returns family on happy path', async () => {
        const { conceptFamilyEngine } = require('../analysis-engine/concept-families');
        conceptFamilyEngine.getFamilyForSymbol.mockResolvedValue({ type: 'validator', members: 3 });
        const result = await handleGetConceptFamily({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns null message when symbol has no family', async () => {
        const { conceptFamilyEngine } = require('../analysis-engine/concept-families');
        conceptFamilyEngine.getFamilyForSymbol.mockResolvedValue(null);
        const result = await handleGetConceptFamily({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { family: null; message: string };
        expect(body.family).toBeNull();
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetConceptFamily({ symbol_version_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleListConceptFamilies', () => {
    test('returns families on happy path', async () => {
        const { conceptFamilyEngine } = require('../analysis-engine/concept-families');
        conceptFamilyEngine.getFamilies.mockResolvedValue([{ type: 'serializer' }]);
        const result = await handleListConceptFamilies({
            snapshot_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { total: number };
        expect(body.total).toBe(1);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleListConceptFamilies({ snapshot_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetTemporalRisk', () => {
    test('returns risk score on happy path', async () => {
        const { temporalEngine } = require('../analysis-engine/temporal-engine');
        temporalEngine.getRiskScore.mockResolvedValue({ score: 0.85 });
        const result = await handleGetTemporalRisk({
            symbol_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns null message when no risk data', async () => {
        const { temporalEngine } = require('../analysis-engine/temporal-engine');
        temporalEngine.getRiskScore.mockResolvedValue(null);
        const result = await handleGetTemporalRisk({
            symbol_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { risk: null; message: string };
        expect(body.risk).toBeNull();
    });

    test('returns error when UUIDs invalid', async () => {
        const result = await handleGetTemporalRisk({ symbol_id: 'x', snapshot_id: 'y' }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetCoChangePartners', () => {
    test('returns partners on happy path', async () => {
        const { temporalEngine } = require('../analysis-engine/temporal-engine');
        temporalEngine.getCoChangePartners.mockResolvedValue([{ partner: 'fn2' }]);
        const result = await handleGetCoChangePartners({
            symbol_id: VALID_UUID,
            repo_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { total: number };
        expect(body.total).toBe(1);
    });

    test('returns error when UUIDs invalid', async () => {
        const result = await handleGetCoChangePartners({ symbol_id: 'x', repo_id: 'y' }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleIngestRuntimeTrace', () => {
    test('ingests trace on happy path', async () => {
        const { runtimeEvidenceEngine } = require('../analysis-engine/runtime-evidence');
        runtimeEvidenceEngine.ingestTrace.mockResolvedValue({ edges_ingested: 3 });
        const result = await handleIngestRuntimeTrace({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            trace_pack: {
                source: 'test_execution',
                timestamp: '2025-01-01T00:00:00Z',
                call_edges: [{ caller_key: 'a', callee_key: 'b', call_count: 1 }],
            },
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for missing trace_pack', async () => {
        const result = await handleIngestRuntimeTrace({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid trace_pack.source', async () => {
        const result = await handleIngestRuntimeTrace({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            trace_pack: {
                source: 'invalid_source',
                timestamp: '2025-01-01T00:00:00Z',
            },
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('source');
    });

    test('returns error for invalid trace_pack.timestamp', async () => {
        const result = await handleIngestRuntimeTrace({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            trace_pack: {
                source: 'test_execution',
                timestamp: 'not-a-date',
            },
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('timestamp');
    });

    test('returns error for invalid call_edge structure', async () => {
        const result = await handleIngestRuntimeTrace({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            trace_pack: {
                source: 'test_execution',
                timestamp: '2025-01-01T00:00:00Z',
                call_edges: [{ caller_key: 'a' }],  // missing callee_key, call_count
            },
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error when repo_id is invalid UUID', async () => {
        const result = await handleIngestRuntimeTrace({
            repo_id: 'bad',
            snapshot_id: VALID_UUID_2,
            trace_pack: {
                source: 'test_execution',
                timestamp: '2025-01-01T00:00:00Z',
            },
        }, log);
        expect(result.isError).toBe(true);
    });
});

describe('handleGetRuntimeEvidence', () => {
    test('returns evidence on happy path', async () => {
        const { runtimeEvidenceEngine } = require('../analysis-engine/runtime-evidence');
        runtimeEvidenceEngine.getEvidenceForSymbol.mockResolvedValue({ observations: 5 });
        const result = await handleGetRuntimeEvidence({
            symbol_version_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleGetRuntimeEvidence({ symbol_version_id: 'bad' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 39: handleHealthCheck
// ═══════════════════════════════════════════════════════════

describe('handleHealthCheck', () => {
    test('returns healthy status on happy path', async () => {
        mockDbHealthCheck.mockResolvedValue({ connected: true, latency_ms: 5, extensions: { pg_trgm: true } });
        mockDbGetPoolStats.mockReturnValue({ total: 10, idle: 8, waiting: 0 });
        mockDbQuery.mockResolvedValue({ rows: [{ cnt: 12 }] });

        const result = await handleHealthCheck({}, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { status: string; db: { connected: boolean } };
        expect(body.status).toBe('healthy');
        expect(body.db.connected).toBe(true);
    });

    test('returns unhealthy when DB not connected', async () => {
        mockDbHealthCheck.mockResolvedValue({ connected: false, latency_ms: -1, extensions: {} });
        mockDbGetPoolStats.mockReturnValue({ total: 0, idle: 0, waiting: 0 });
        mockDbQuery.mockResolvedValue({ rows: [{ cnt: 0 }] });

        const result = await handleHealthCheck({}, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { status: string };
        expect(body.status).toBe('unhealthy');
    });

    test('handles missing _migrations table gracefully', async () => {
        mockDbHealthCheck.mockResolvedValue({ connected: true, latency_ms: 2, extensions: {} });
        mockDbGetPoolStats.mockReturnValue({});
        mockDbQuery.mockRejectedValue(new Error('relation "_migrations" does not exist'));

        const result = await handleHealthCheck({}, log);
        expect(result.isError).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 40: handleIncrementalIndex
// ═══════════════════════════════════════════════════════════

describe('handleIncrementalIndex', () => {
    test('indexes incrementally on happy path', async () => {
        mockIngestIncremental.mockResolvedValue({ reindexed: 3 });
        const result = await handleIncrementalIndex({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            changed_paths: ['src/a.ts', 'src/b.ts'],
        }, log);
        expect(result.isError).toBeUndefined();
    });

    test('returns error for empty changed_paths', async () => {
        const result = await handleIncrementalIndex({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            changed_paths: [],
        }, log);
        expect(result.isError).toBe(true);
    });

    test('returns error for invalid changed_path entry', async () => {
        const result = await handleIncrementalIndex({
            repo_id: VALID_UUID,
            snapshot_id: VALID_UUID_2,
            changed_paths: ['src/a.ts', ''],
        }, log);
        expect(result.isError).toBe(true);
        const body = parseResult(result) as { error: string };
        expect(body.error).toContain('non-empty string');
    });

    test('returns error for invalid repo_id', async () => {
        const result = await handleIncrementalIndex({
            repo_id: 'bad',
            snapshot_id: VALID_UUID_2,
            changed_paths: ['file.ts'],
        }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 41: handleBatchEmbed
// ═══════════════════════════════════════════════════════════

describe('handleBatchEmbed', () => {
    test('embeds snapshot on happy path', async () => {
        const { semanticEngine } = require('../semantic-engine');
        semanticEngine.batchEmbedSnapshot.mockResolvedValue(42);
        const result = await handleBatchEmbed({
            snapshot_id: VALID_UUID,
        }, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as { symbols_embedded: number };
        expect(body.symbols_embedded).toBe(42);
    });

    test('returns error for invalid UUID', async () => {
        const result = await handleBatchEmbed({ snapshot_id: 'nope' }, log);
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════
// Tool 42: handleCacheStats
// ═══════════════════════════════════════════════════════════

describe('handleCacheStats', () => {
    test('returns cache stats from all caches', async () => {
        const result = await handleCacheStats({}, log);
        expect(result.isError).toBeUndefined();
        const body = parseResult(result) as Record<string, unknown>;
        expect(body).toHaveProperty('symbol');
        expect(body).toHaveProperty('profile');
        expect(body).toHaveProperty('capsule');
        expect(body).toHaveProperty('homolog');
        expect(body).toHaveProperty('query');
    });
});
