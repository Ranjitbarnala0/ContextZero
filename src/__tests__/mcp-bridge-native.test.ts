const mockCreateRepository = jest.fn();
const mockGetRepository = jest.fn();
const mockIngestRepo = jest.fn();
const mockEnsureAllowedRepoPath = jest.fn();
const mockDeriveWorkspaceSnapshotIdentity = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: jest.fn(),
    },
}));

jest.mock('../db-driver/core_data', () => ({
    coreDataService: {
        createRepository: (...args: unknown[]) => mockCreateRepository(...args),
        getRepository: (...args: unknown[]) => mockGetRepository(...args),
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
    },
}));

jest.mock('../workspace-native', () => ({
    ensureAllowedRepoPath: (...args: unknown[]) => mockEnsureAllowedRepoPath(...args),
    deriveWorkspaceSnapshotIdentity: (...args: unknown[]) => mockDeriveWorkspaceSnapshotIdentity(...args),
    buildNativeCodebaseOverview: jest.fn(),
    searchWorkspaceCode: jest.fn(),
    searchWorkspaceSymbols: jest.fn(),
}));

describe('mcp bridge native repo flows', () => {
    const log: McpLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('auto-registers repo_path ingestion and derives a workspace snapshot when commit is omitted', async () => {
        mockEnsureAllowedRepoPath.mockReturnValue('/tmp/demo-repo');
        mockCreateRepository.mockResolvedValue('11111111-1111-1111-1111-111111111111');
        mockDeriveWorkspaceSnapshotIdentity.mockResolvedValue({
            commit_sha: 'workspace-deadbeef',
            branch: 'workspace',
            source: 'workspace',
            files_considered: 12,
            truncated: false,
        });
        mockIngestRepo.mockResolvedValue({
            repo_id: 'ignored-by-handler',
            snapshot_id: '22222222-2222-2222-2222-222222222222',
            files_processed: 4,
            files_failed: 0,
            symbols_extracted: 7,
            relations_extracted: 2,
            behavior_hints_extracted: 1,
            contract_hints_extracted: 1,
            duration_ms: 10,
        });

        const { handleIngestRepo } = await import('../mcp-bridge/handlers');
        const result = await handleIngestRepo({
            repo_path: '/tmp/demo-repo',
            repo_name: 'demo-repo',
        }, log);

        expect(result.isError).toBeUndefined();
        expect(mockCreateRepository).toHaveBeenCalledWith(expect.objectContaining({
            name: 'demo-repo',
            base_path: '/tmp/demo-repo',
            default_branch: 'main',
        }));
        expect(mockDeriveWorkspaceSnapshotIdentity).toHaveBeenCalledWith('/tmp/demo-repo', {
            commitSha: undefined,
            branch: 'main',
        });
        expect(mockIngestRepo).toHaveBeenCalledWith(
            '/tmp/demo-repo',
            'demo-repo',
            'workspace-deadbeef',
            'workspace',
        );

        const payload = JSON.parse(result.content[0]?.text || '{}');
        expect(payload.result.commit_source).toBe('workspace');
        expect(payload.result.auto_registered).toBe(true);
        expect(payload.result.repo_id).toBe('11111111-1111-1111-1111-111111111111');
    });
});
import type { McpLogger } from '../mcp-bridge/index';
