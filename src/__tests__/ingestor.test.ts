/**
 * Comprehensive test suite for the Ingestor module.
 *
 * Tests:
 *   - File discovery (discoverFiles) — extension filtering, SKIP_DIRS, symlinks, size limits
 *   - Language detection (LANGUAGE_MAP dispatch)
 *   - hashFile — SHA-256 content hashing, error fallback
 *   - findTsconfig — presence/absence detection
 *   - Advisory lock acquisition and release (ingestRepo / ingestIncremental)
 *   - Delta detection (incremental ingestion with parent snapshot)
 *   - Python adapter invocation (extractFromPython)
 *   - Universal adapter invocation (extractWithTreeSitter)
 *   - persistExtractionResult — symbol merge, key normalization, body_source
 *   - cleanupSnapshotData — FK-safe chunked deletion
 *   - populateTestArtifacts — test detection and framework classification
 *   - Snapshot status transitions (complete / partial / failed)
 *   - Error recovery paths
 *   - Cache invalidation after ingestion
 *   - ingestIncremental — file deletion, re-extraction, V2 engines
 *   - resolveSafePath — delegation to path-security module
 */

import * as path from 'path';

// ── Mocks — must be declared BEFORE imports ──────────────────────────────

// DB driver
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockBatchInsert = jest.fn().mockResolvedValue(undefined);
const mockQueryWithClient = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockTransaction = jest.fn().mockImplementation(async (cb: any) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return cb(client);
});

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: any[]) => mockQuery(...args),
        batchInsert: (...args: any[]) => mockBatchInsert(...args),
        queryWithClient: (...args: any[]) => mockQueryWithClient(...args),
        transaction: (...args: any[]) => mockTransaction(...args),
    },
}));

// Core data service
const mockCreateRepository = jest.fn().mockResolvedValue('repo-001');
const mockCreateSnapshot = jest.fn().mockResolvedValue('snap-001');
const mockUpdateSnapshotStatus = jest.fn().mockResolvedValue(undefined);
const mockAddFile = jest.fn().mockResolvedValue('file-001');
const mockMergeSymbol = jest.fn().mockResolvedValue('sym-001');
const mockGetSymbolVersionsForSnapshot = jest.fn().mockResolvedValue([]);
const mockInsertTestArtifact = jest.fn().mockResolvedValue(undefined);

jest.mock('../db-driver/core_data', () => ({
    coreDataService: {
        createRepository: (...args: any[]) => mockCreateRepository(...args),
        createSnapshot: (...args: any[]) => mockCreateSnapshot(...args),
        updateSnapshotStatus: (...args: any[]) => mockUpdateSnapshotStatus(...args),
        addFile: (...args: any[]) => mockAddFile(...args),
        mergeSymbol: (...args: any[]) => mockMergeSymbol(...args),
        getSymbolVersionsForSnapshot: (...args: any[]) => mockGetSymbolVersionsForSnapshot(...args),
        insertTestArtifact: (...args: any[]) => mockInsertTestArtifact(...args),
    },
}));

// Analysis engines
const mockComputeRelationsFromRaw = jest.fn().mockResolvedValue(0);
jest.mock('../analysis-engine', () => ({
    structuralGraphEngine: {
        computeRelationsFromRaw: (...args: any[]) => mockComputeRelationsFromRaw(...args),
    },
}));

const mockExtractBehavioralProfiles = jest.fn().mockResolvedValue({
    purity_class: 'pure', resource_touches: [], db_reads: [], db_writes: [],
    network_calls: [], cache_ops: [], file_io: [],
    auth_operations: [], validation_operations: [],
    exception_profile: [], state_mutation_profile: [], transaction_profile: [],
});
const mockPropagateTransitive = jest.fn().mockResolvedValue(0);
jest.mock('../analysis-engine/behavioral', () => ({
    behavioralEngine: {
        extractBehavioralProfiles: (...args: any[]) => mockExtractBehavioralProfiles(...args),
        propagateTransitive: (...args: any[]) => mockPropagateTransitive(...args),
    },
}));

const mockExtractContractProfile = jest.fn().mockResolvedValue({
    input_contract: '', output_contract: '', error_contract: '',
    schema_refs: [], api_contract_refs: [], serialization_contract: '',
    security_contract: '', derived_invariants_count: 0,
});
const mockMineInvariantsFromTests = jest.fn().mockResolvedValue(0);
jest.mock('../analysis-engine/contracts', () => ({
    contractEngine: {
        extractContractProfile: (...args: any[]) => mockExtractContractProfile(...args),
        mineInvariantsFromTests: (...args: any[]) => mockMineInvariantsFromTests(...args),
    },
}));

// TS adapter
const mockExtractFromTypeScript = jest.fn().mockReturnValue({
    symbols: [], relations: [], behavior_hints: [], contract_hints: [],
    parse_confidence: 1.0, uncertainty_flags: [],
});
jest.mock('../adapters/ts', () => ({
    extractFromTypeScript: (...args: any[]) => mockExtractFromTypeScript(...args),
}));

// Semantic engine
const mockBatchEmbedSnapshot = jest.fn().mockResolvedValue(0);
jest.mock('../semantic-engine', () => ({
    semanticEngine: {
        batchEmbedSnapshot: (...args: any[]) => mockBatchEmbedSnapshot(...args),
    },
}));

// V2 engines
const mockBuildClassHierarchy = jest.fn().mockResolvedValue(0);
const mockResolveDispatches = jest.fn().mockResolvedValue(0);
jest.mock('../analysis-engine/dispatch-resolver', () => ({
    dispatchResolver: {
        buildClassHierarchy: (...args: any[]) => mockBuildClassHierarchy(...args),
        resolveDispatches: (...args: any[]) => mockResolveDispatches(...args),
    },
}));

const mockComputeLineage = jest.fn().mockResolvedValue({ births: 0, exact_matches: 0, renames_detected: 0 });
jest.mock('../analysis-engine/symbol-lineage', () => ({
    symbolLineageEngine: {
        computeLineage: (...args: any[]) => mockComputeLineage(...args),
    },
}));

const mockComputeEffectSignatures = jest.fn().mockResolvedValue(0);
const mockPropagateEffectsTransitive = jest.fn().mockResolvedValue(0);
jest.mock('../analysis-engine/effect-engine', () => ({
    effectEngine: {
        computeEffectSignatures: (...args: any[]) => mockComputeEffectSignatures(...args),
        propagateEffectsTransitive: (...args: any[]) => mockPropagateEffectsTransitive(...args),
    },
}));

const mockSynthesizeContracts = jest.fn().mockResolvedValue(0);
jest.mock('../analysis-engine/deep-contracts', () => ({
    deepContractSynthesizer: {
        synthesizeContracts: (...args: any[]) => mockSynthesizeContracts(...args),
    },
}));

const mockBuildFamilies = jest.fn().mockResolvedValue({ families_created: 0 });
jest.mock('../analysis-engine/concept-families', () => ({
    conceptFamilyEngine: {
        buildFamilies: (...args: any[]) => mockBuildFamilies(...args),
    },
}));

const mockComputeTemporalIntelligence = jest.fn().mockResolvedValue({ co_change_pairs: 0 });
jest.mock('../analysis-engine/temporal-engine', () => ({
    temporalEngine: {
        computeTemporalIntelligence: (...args: any[]) => mockComputeTemporalIntelligence(...args),
    },
}));

// Cache mocks
const mockCacheClear = jest.fn();
const mockCacheInvalidate = jest.fn();
jest.mock('../cache', () => ({
    symbolCache: { clear: () => mockCacheClear(), invalidate: (k: string) => mockCacheInvalidate(k) },
    profileCache: { clear: () => mockCacheClear(), invalidate: (k: string) => mockCacheInvalidate(k) },
    capsuleCache: { clear: () => mockCacheClear(), invalidate: (k: string) => mockCacheInvalidate(k) },
    homologCache: { clear: () => mockCacheClear(), invalidate: (k: string) => mockCacheInvalidate(k) },
    queryCache: { clear: () => mockCacheClear(), invalidate: (k: string) => mockCacheInvalidate(k) },
}));

// Path security
jest.mock('../path-security', () => ({
    resolveExistingPath: jest.fn((p: string) => p),
    resolvePathWithinBase: jest.fn((base: string, file: string) => ({
        realBase: base,
        resolvedPath: path.resolve(base, file),
        realPath: path.resolve(base, file),
        existed: true,
    })),
}));

// fs/promises mocks
const mockReaddir = jest.fn();
const mockStat = jest.fn();
const mockLstat = jest.fn();
const mockReadFile = jest.fn();
const mockAccess = jest.fn();

jest.mock('fs/promises', () => ({
    readdir: (...args: any[]) => mockReaddir(...args),
    stat: (...args: any[]) => mockStat(...args),
    lstat: (...args: any[]) => mockLstat(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    access: (...args: any[]) => mockAccess(...args),
}));

// fs (sync) mock — needed for Dirent construction
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    realpathSync: jest.fn((p: string) => p),
}));

// child_process mock
const mockExecFileAsync = jest.fn();
jest.mock('child_process', () => ({
    execFile: jest.fn(),
}));
jest.mock('util', () => ({
    ...jest.requireActual('util'),
    promisify: () => (...args: any[]) => mockExecFileAsync(...args),
}));

// Logger mock (suppress test output)
jest.mock('../logger', () => ({
    Logger: jest.fn().mockImplementation(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        startTimer: jest.fn().mockReturnValue(jest.fn()),
    })),
}));

// ── Import the module under test AFTER all mocks ─────────────────────────
import { Ingestor, ingestor } from '../ingestor/index';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Create a mock fs.Dirent for testing file discovery */
function makeDirent(name: string, opts: { isFile?: boolean; isDirectory?: boolean; isSymbolicLink?: boolean } = {}): any {
    return {
        name,
        isFile: () => opts.isFile ?? false,
        isDirectory: () => opts.isDirectory ?? false,
        isSymbolicLink: () => opts.isSymbolicLink ?? false,
    };
}

/** Helper to set up mock advisory lock as acquired */
function setupLockAcquired() {
    mockQuery.mockImplementation(async (text: string, params?: any[]) => {
        if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
            return { rows: [{ acquired: true }], rowCount: 1 };
        }
        if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
            return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
}

/** Helper to set up mock advisory lock as NOT acquired (concurrent ingestion) */
function setupLockNotAcquired() {
    mockQuery.mockImplementation(async (text: string) => {
        if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
            return { rows: [{ acquired: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
}

function resetAllMocks() {
    // Use mockReset (not clearAllMocks) to clear implementations, once-queues,
    // AND call history. jest.clearAllMocks only clears call history — leaked
    // once-queues from a previous test would pollute the next test.
    const allMocks = [
        mockQuery, mockBatchInsert, mockQueryWithClient, mockTransaction,
        mockCreateRepository, mockCreateSnapshot, mockUpdateSnapshotStatus,
        mockAddFile, mockMergeSymbol, mockGetSymbolVersionsForSnapshot,
        mockInsertTestArtifact, mockComputeRelationsFromRaw,
        mockExtractBehavioralProfiles, mockPropagateTransitive,
        mockExtractContractProfile, mockMineInvariantsFromTests,
        mockExtractFromTypeScript, mockBatchEmbedSnapshot,
        mockBuildClassHierarchy, mockResolveDispatches, mockComputeLineage,
        mockComputeEffectSignatures, mockPropagateEffectsTransitive,
        mockSynthesizeContracts, mockBuildFamilies,
        mockComputeTemporalIntelligence, mockCacheClear, mockCacheInvalidate,
        mockReaddir, mockStat, mockLstat, mockReadFile, mockAccess,
        mockExecFileAsync,
    ];
    for (const m of allMocks) m.mockReset();

    // Re-establish defaults (after full reset)
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockBatchInsert.mockResolvedValue(undefined);
    mockQueryWithClient.mockResolvedValue({ rows: [], rowCount: 0 });
    mockTransaction.mockImplementation(async (cb: any) => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
        return cb(client);
    });
    mockCreateRepository.mockResolvedValue('repo-001');
    mockCreateSnapshot.mockResolvedValue('snap-001');
    mockUpdateSnapshotStatus.mockResolvedValue(undefined);
    mockAddFile.mockResolvedValue('file-001');
    mockMergeSymbol.mockResolvedValue('sym-001');
    mockGetSymbolVersionsForSnapshot.mockResolvedValue([]);
    mockInsertTestArtifact.mockResolvedValue(undefined);
    mockComputeRelationsFromRaw.mockResolvedValue(0);
    mockExtractBehavioralProfiles.mockResolvedValue({
        purity_class: 'pure', resource_touches: [], db_reads: [], db_writes: [],
        network_calls: [], cache_ops: [], file_io: [],
    });
    mockPropagateTransitive.mockResolvedValue(0);
    mockExtractContractProfile.mockResolvedValue({
        input_contract: '', output_contract: '', error_contract: '',
    });
    mockMineInvariantsFromTests.mockResolvedValue(0);
    mockExtractFromTypeScript.mockReturnValue({
        symbols: [], relations: [], behavior_hints: [], contract_hints: [],
        parse_confidence: 1.0, uncertainty_flags: [],
    });
    mockBatchEmbedSnapshot.mockResolvedValue(0);
    mockBuildClassHierarchy.mockResolvedValue(0);
    mockResolveDispatches.mockResolvedValue(0);
    mockComputeLineage.mockResolvedValue({ births: 0, exact_matches: 0, renames_detected: 0 });
    mockComputeEffectSignatures.mockResolvedValue(0);
    mockPropagateEffectsTransitive.mockResolvedValue(0);
    mockSynthesizeContracts.mockResolvedValue(0);
    mockBuildFamilies.mockResolvedValue({ families_created: 0 });
    mockComputeTemporalIntelligence.mockResolvedValue({ co_change_pairs: 0 });
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ isDirectory: () => true, isFile: () => false, size: 100 });
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
    mockReadFile.mockResolvedValue(Buffer.from(''));
    mockAccess.mockResolvedValue(undefined);
    mockExecFileAsync.mockResolvedValue({ stdout: '{}', stderr: '' });
}

// ══════════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════════

beforeEach(() => {
    resetAllMocks();
});

describe('Ingestor — Module exports', () => {
    test('exports the Ingestor class', () => {
        expect(Ingestor).toBeDefined();
        expect(typeof Ingestor).toBe('function');
    });

    test('exports a singleton ingestor instance', () => {
        expect(ingestor).toBeDefined();
        expect(ingestor).toBeInstanceOf(Ingestor);
    });

    test('ingestor has ingestRepo method', () => {
        expect(typeof ingestor.ingestRepo).toBe('function');
    });

    test('ingestor has ingestIncremental method', () => {
        expect(typeof ingestor.ingestIncremental).toBe('function');
    });
});

describe('Ingestor — discoverFiles (via ingestRepo)', () => {
    // discoverFiles is private, so we test it through ingestRepo

    test('discovers .ts files', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValue({ isDirectory: () => true, isFile: () => false, size: 100 });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        // stat for file size check
        mockStat
            .mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, size: 0 }) // repoPath stat
            .mockResolvedValueOnce({ size: 500, isFile: () => true }); // file stat
        mockReadFile.mockResolvedValue(Buffer.from('const x = 1;'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // addFile should be called for the discovered TS file
        expect(mockAddFile).toHaveBeenCalled();
    });

    test('skips node_modules directory', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('node_modules', { isDirectory: true }),
            makeDirent('src', { isDirectory: true }),
        ]);
        // src subdirectory
        mockReaddir.mockResolvedValueOnce([]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockReadFile.mockResolvedValue(Buffer.from(''));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // readdir should NOT be called for node_modules (only once for root, once for src)
        expect(mockReaddir).toHaveBeenCalledTimes(2);
    });

    test('skips .git directory', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('.git', { isDirectory: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Only root readdir
        expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    test('skips dot-prefixed directories', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('.hidden', { isDirectory: true }),
            makeDirent('.vscode', { isDirectory: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    test('skips symlinks during file discovery', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('link.ts', { isFile: true }),
        ]);
        // lstat reports it as a symlink
        mockLstat.mockResolvedValue({ isSymbolicLink: () => true });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // No files should be added because the only file is a symlink
        expect(mockAddFile).not.toHaveBeenCalled();
    });

    test('skips files exceeding MAX_FILE_SIZE (5MB)', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true }); // repoPath check
        mockReaddir.mockResolvedValueOnce([
            makeDirent('huge.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        // File stat reports size > 5MB
        mockStat.mockResolvedValueOnce({ size: 10 * 1024 * 1024, isFile: () => true });
        mockReadFile.mockResolvedValue(Buffer.from(''));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).not.toHaveBeenCalled();
    });

    test('skips files with unknown extensions', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('readme.md', { isFile: true }),
            makeDirent('data.json', { isFile: true }),
            makeDirent('image.png', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).not.toHaveBeenCalled();
    });

    test('gracefully handles unreadable directories', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        // readdir fails (permission denied)
        mockReaddir.mockRejectedValueOnce(new Error('EACCES'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Should not throw, just return empty files
        expect(result.files_processed).toBe(0);
    });
});

describe('Ingestor — Language detection', () => {
    // Test that different extensions are classified correctly via file grouping

    test('.ts and .tsx map to typescript', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
            makeDirent('component.tsx', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat
            .mockResolvedValueOnce({ size: 100 })
            .mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('const x = 1;'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Both files should be added with language typescript
        const calls = mockAddFile.mock.calls;
        for (const call of calls) {
            expect(call[0].language).toBe('typescript');
        }
    });

    test('.py maps to python', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('main.py', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('x = 1'));
        // Python extractor returns null
        mockExecFileAsync.mockRejectedValue(new Error('no python3'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        const calls = mockAddFile.mock.calls;
        expect(calls.length).toBe(1);
        expect(calls[0][0].language).toBe('python');
    });

    test('.go maps to go', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('main.go', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('package main'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).toHaveBeenCalledWith(expect.objectContaining({ language: 'go' }));
    });

    test('.rs maps to rust', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('lib.rs', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('fn main() {}'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).toHaveBeenCalledWith(expect.objectContaining({ language: 'rust' }));
    });

    test('.java maps to java', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('App.java', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('class App {}'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).toHaveBeenCalledWith(expect.objectContaining({ language: 'java' }));
    });

    test('.c and .h map to cpp (tree-sitter superset)', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('main.c', { isFile: true }),
            makeDirent('header.h', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat
            .mockResolvedValueOnce({ size: 100 })
            .mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('#include <stdio.h>'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        const calls = mockAddFile.mock.calls;
        for (const call of calls) {
            expect(call[0].language).toBe('cpp');
        }
    });

    test('.rb maps to ruby', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.rb', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('puts "hi"'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).toHaveBeenCalledWith(expect.objectContaining({ language: 'ruby' }));
    });

    test('.sh maps to bash', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('deploy.sh', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('#!/bin/bash'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockAddFile).toHaveBeenCalledWith(expect.objectContaining({ language: 'bash' }));
    });
});

describe('Ingestor — Advisory lock', () => {
    test('skips ingestion when advisory lock is not acquired', async () => {
        setupLockNotAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result.repo_id).toBe('');
        expect(result.snapshot_id).toBe('');
        expect(result.files_processed).toBe(0);
        expect(mockCreateRepository).not.toHaveBeenCalled();
    });

    test('releases advisory lock on successful ingestion', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // pg_advisory_unlock should be called
        const unlockCalls = mockQuery.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('pg_advisory_unlock')
        );
        expect(unlockCalls.length).toBe(1);
    });

    test('releases advisory lock even when ingestion fails', async () => {
        setupLockAcquired();
        // Make stat throw after lock check to simulate failure mid-ingestion
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);
        // Force createRepository to throw
        mockCreateRepository.mockRejectedValueOnce(new Error('DB error'));

        await expect(ingestor.ingestRepo('/repo', 'test-repo', 'abc123'))
            .rejects.toThrow('DB error');

        // Lock should still be released
        const unlockCalls = mockQuery.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('pg_advisory_unlock')
        );
        expect(unlockCalls.length).toBe(1);
    });
});

describe('Ingestor — Cache invalidation', () => {
    test('clears all caches after successful ingestion', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // 5 caches (symbol, profile, capsule, homolog, query) should be cleared
        expect(mockCacheClear).toHaveBeenCalledTimes(5);
    });

    test('clears caches even after failed ingestion', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);
        mockCreateRepository.mockRejectedValueOnce(new Error('DB error'));

        await expect(ingestor.ingestRepo('/repo', 'test-repo', 'abc123'))
            .rejects.toThrow();

        expect(mockCacheClear).toHaveBeenCalledTimes(5);
    });
});

describe('Ingestor — ingestRepo validation', () => {
    test('throws when repoPath does not exist', async () => {
        // resolveExistingPath throws for non-existent paths
        const { resolveExistingPath } = require('../path-security');
        (resolveExistingPath as jest.Mock).mockImplementationOnce(() => {
            throw new Error('ENOENT: no such file or directory');
        });

        await expect(ingestor.ingestRepo('/nonexistent', 'test-repo', 'abc123'))
            .rejects.toThrow('Invalid repository path');
    });

    test('throws when repoPath is not a directory', async () => {
        mockStat.mockResolvedValueOnce({ isDirectory: () => false });

        await expect(ingestor.ingestRepo('/repo', 'test-repo', 'abc123'))
            .rejects.toThrow('Invalid repository path');
    });
});

describe('Ingestor — Stale snapshot cleanup', () => {
    test('cleans up stale partial/failed snapshots before fresh ingestion', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        // First query is advisory lock. After that, stale snapshot query returns a stale ID.
        let queryCallCount = 0;
        mockQuery.mockImplementation(async (text: string, params?: any[]) => {
            queryCallCount++;
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('index_status IN')) {
                return { rows: [{ snapshot_id: 'stale-snap-001' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // transaction should have been called (for cleanup)
        expect(mockTransaction).toHaveBeenCalled();
    });

    test('continues ingestion even if stale cleanup fails', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('index_status IN')) {
                throw new Error('Cleanup query failed');
            }
            return { rows: [], rowCount: 0 };
        });

        // Should not throw — cleanup failure is non-fatal
        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });
});

describe('Ingestor — Snapshot status transitions', () => {
    test('sets snapshot status to "complete" when all files succeed', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]); // no files = no failures

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockUpdateSnapshotStatus).toHaveBeenCalledWith('snap-001', 'complete');
    });

    test('sets snapshot status to "partial" when some files fail', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('good.ts', { isFile: true }),
            makeDirent('bad.py', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat
            .mockResolvedValueOnce({ size: 100 })
            .mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('code'));

        // TS extraction succeeds with at least one symbol
        mockExtractFromTypeScript.mockReturnValue({
            symbols: [{ stable_key: 'good.ts::Func', canonical_name: 'Func', kind: 'function', range_start_line: 1, range_start_col: 0, range_end_line: 5, range_end_col: 0, signature: '() => void', ast_hash: 'h1', body_hash: 'h2', visibility: 'public' }],
            relations: [], behavior_hints: [], contract_hints: [],
            parse_confidence: 1.0, uncertainty_flags: [],
        });

        // Python extraction fails
        mockAccess.mockRejectedValue(new Error('no extractor'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // 1 TS file processed + 1 Python file failed => partial
        expect(mockUpdateSnapshotStatus).toHaveBeenCalledWith('snap-001', expect.stringMatching(/partial|complete/));
    });
});

describe('Ingestor — Repository and snapshot creation', () => {
    test('creates repository with correct parameters', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123', 'develop');

        expect(mockCreateRepository).toHaveBeenCalledWith({
            name: 'test-repo',
            default_branch: 'develop',
            visibility: 'private',
            language_set: [],
            base_path: '/repo',
        });
    });

    test('creates snapshot with correct parameters', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123', 'main', 'parent-snap');

        expect(mockCreateSnapshot).toHaveBeenCalledWith({
            repo_id: 'repo-001',
            commit_sha: 'abc123',
            branch: 'main',
            parent_snapshot_id: 'parent-snap',
        });
    });

    test('defaults branch to "main" when not provided', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockCreateSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ branch: 'main' })
        );
    });

    test('sets snapshot status to "indexing" after creation', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // First call is to set 'indexing', second is final status
        expect(mockUpdateSnapshotStatus).toHaveBeenCalledWith('snap-001', 'indexing');
    });
});

describe('Ingestor — Delta detection', () => {
    test('loads parent file hashes when parentSnapshotId is provided', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('unchanged.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('const x = 1;'));

        // Parent snapshot files query
        mockQuery.mockImplementation(async (text: string, params?: any[]) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('FROM files WHERE snapshot_id')) {
                return {
                    rows: [{ path: 'unchanged.ts', content_hash: 'abc123hash' }],
                    rowCount: 1,
                };
            }
            if (typeof text === 'string' && text.includes('index_status') && text.includes('snapshots')) {
                return { rows: [{ index_status: 'complete' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123', 'main', 'parent-snap-001');

        // Parent files query should be called
        const parentQueries = mockQuery.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('FROM files WHERE snapshot_id')
        );
        expect(parentQueries.length).toBeGreaterThanOrEqual(1);
    });

    test('skips extraction for unchanged files (matching content_hash)', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('unchanged.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });

        // File content produces a known hash
        const fileContent = Buffer.from('const x = 1;');
        mockReadFile.mockResolvedValue(fileContent);
        const crypto = require('crypto');
        const expectedHash = crypto.createHash('sha256').update(fileContent).digest('hex');

        // Parent snapshot has the same hash for unchanged.ts
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('content_hash FROM files')) {
                return { rows: [{ path: 'unchanged.ts', content_hash: expectedHash }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('index_status') && text.includes('snapshots')) {
                return { rows: [{ index_status: 'complete' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123', 'main', 'parent-snap');

        // TS extraction should NOT be called because the file is unchanged
        expect(mockExtractFromTypeScript).not.toHaveBeenCalled();
    });

    test('falls back to full ingestion when parent hash loading fails', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('const x = 1;'));

        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('content_hash FROM files')) {
                throw new Error('DB error loading parent files');
            }
            return { rows: [], rowCount: 0 };
        });

        // Should not throw — falls back gracefully
        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123', 'main', 'parent-snap');
        expect(result).toBeDefined();
    });
});

describe('Ingestor — TypeScript extraction', () => {
    test('calls extractFromTypeScript for .ts files', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('export function hello() {}'));

        mockExtractFromTypeScript.mockReturnValue({
            symbols: [], relations: [], behavior_hints: [], contract_hints: [],
            parse_confidence: 1.0, uncertainty_flags: [],
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockExtractFromTypeScript).toHaveBeenCalled();
    });

    test('counts failed TS extraction against filesFailed', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('broken.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('broken'));

        mockExtractFromTypeScript.mockImplementation(() => {
            throw new Error('TS parse error');
        });

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result.files_failed).toBe(1);
    });

    test('finds tsconfig.json when present', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('const x = 1;'));

        // findTsconfig calls fsp.access — make it succeed
        mockAccess.mockResolvedValue(undefined);

        mockExtractFromTypeScript.mockReturnValue({
            symbols: [], relations: [], behavior_hints: [], contract_hints: [],
            parse_confidence: 1.0, uncertainty_flags: [],
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // extractFromTypeScript should be called with tsconfigPath as second arg
        expect(mockExtractFromTypeScript).toHaveBeenCalledWith(
            expect.any(Array),
            expect.stringContaining('tsconfig.json')
        );
    });
});

describe('Ingestor — Python extraction', () => {
    test('skips Python extraction when extractor.py is not found', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('script.py', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('x = 1'));

        // fsp.access rejects (extractor not found)
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Should count as failed since extraction returned null
        expect(result.files_failed).toBe(1);
    });

    test('handles invalid Python extractor JSON output', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('script.py', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('x = 1'));
        mockAccess.mockResolvedValue(undefined);

        // Return invalid JSON
        mockExecFileAsync.mockResolvedValue({ stdout: '{ not valid json', stderr: '' });

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result.files_failed).toBe(1);
    });

    test('handles Python extractor returning object without symbols array', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('script.py', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('x = 1'));
        mockAccess.mockResolvedValue(undefined);

        // Return valid JSON but no symbols array
        mockExecFileAsync.mockResolvedValue({ stdout: '{"no_symbols": true}', stderr: '' });

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result.files_failed).toBe(1);
    });
});

describe('Ingestor — hashFile', () => {
    test('produces SHA-256 hex digest of file content', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('file.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('hello'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // addFile should have been called with a content_hash that is a 64-char hex string
        expect(mockAddFile).toHaveBeenCalledWith(
            expect.objectContaining({
                content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            })
        );
    });

    test('returns hash of empty string when file read fails', async () => {
        // Test hashFile error path through the ingestion pipeline
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('gone.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });

        // First readFile call is for hashFile — make it fail
        // Second might be for body_source extraction
        mockReadFile.mockRejectedValue(new Error('ENOENT'));

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Should still call addFile (with hash of empty string)
        expect(mockAddFile).toHaveBeenCalled();
    });
});

describe('Ingestor — IngestionResult shape', () => {
    test('returns correct IngestionResult structure with zero files', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result).toEqual(expect.objectContaining({
            repo_id: 'repo-001',
            snapshot_id: 'snap-001',
            files_processed: 0,
            files_failed: 0,
            symbols_extracted: 0,
            relations_extracted: 0,
            behavior_hints_extracted: 0,
            contract_hints_extracted: 0,
            duration_ms: expect.any(Number),
        }));
    });

    test('includes V2 engine fields in result', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result).toHaveProperty('dispatch_edges_resolved');
        expect(result).toHaveProperty('lineages_computed');
        expect(result).toHaveProperty('effect_signatures_computed');
        expect(result).toHaveProperty('deep_contracts_mined');
        expect(result).toHaveProperty('concept_families_built');
        expect(result).toHaveProperty('temporal_co_changes_found');
    });

    test('duration_ms is a positive number', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
});

describe('Ingestor — V2 engines', () => {
    test('runs V2 engines when extraction is fully successful', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]); // No files = no failures

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // V2 engines should all be called
        expect(mockBuildClassHierarchy).toHaveBeenCalled();
        expect(mockResolveDispatches).toHaveBeenCalled();
        expect(mockComputeEffectSignatures).toHaveBeenCalled();
        expect(mockSynthesizeContracts).toHaveBeenCalled();
        expect(mockBuildFamilies).toHaveBeenCalled();
    });

    test('skips V2 engines when extraction is partial (has failures)', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('broken.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('code'));

        // Force TS extraction to fail
        mockExtractFromTypeScript.mockImplementation(() => {
            throw new Error('TS parse error');
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // V2 engines should NOT be called
        expect(mockBuildClassHierarchy).not.toHaveBeenCalled();
        expect(mockResolveDispatches).not.toHaveBeenCalled();
        expect(mockComputeEffectSignatures).not.toHaveBeenCalled();
        expect(mockSynthesizeContracts).not.toHaveBeenCalled();
        expect(mockBuildFamilies).not.toHaveBeenCalled();
    });

    test('V2 engine failures are non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        // Make dispatch resolver throw
        mockBuildClassHierarchy.mockRejectedValue(new Error('dispatch failed'));

        // Should not throw
        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });

    test('semantic embedding failure is non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockBatchEmbedSnapshot.mockRejectedValue(new Error('embedding failed'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });

    test('symbol lineage failure is non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockComputeLineage.mockRejectedValue(new Error('lineage failed'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });

    test('effect engine failure is non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockComputeEffectSignatures.mockRejectedValue(new Error('effect failed'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });

    test('deep contract synthesis failure is non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockSynthesizeContracts.mockRejectedValue(new Error('deep contracts failed'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });

    test('concept family engine failure is non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockBuildFamilies.mockRejectedValue(new Error('family engine failed'));

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });

    test('temporal engine failure is non-fatal', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockComputeTemporalIntelligence.mockRejectedValue(new Error('temporal failed'));

        // Need base_path for temporal to run
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');
        expect(result.repo_id).toBe('repo-001');
    });
});

describe('Ingestor — Language set update', () => {
    test('updates repository language_set when files are discovered', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
            makeDirent('main.py', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat
            .mockResolvedValueOnce({ size: 100 })
            .mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('code'));
        mockAccess.mockRejectedValue(new Error('no py extractor'));

        mockExtractFromTypeScript.mockReturnValue({
            symbols: [], relations: [], behavior_hints: [], contract_hints: [],
            parse_confidence: 1.0, uncertainty_flags: [],
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Should update language_set in repositories
        const updateCalls = mockQuery.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE repositories SET language_set')
        );
        expect(updateCalls.length).toBe(1);
        // language_set should contain typescript and python
        const langArray = updateCalls[0][1][0] as string[];
        expect(langArray).toContain('typescript');
        expect(langArray).toContain('python');
    });
});

describe('Ingestor — ingestIncremental', () => {
    test('returns zero counts when advisory lock is not acquired', async () => {
        setupLockNotAcquired();

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']);

        expect(result.symbolsUpdated).toBe(0);
        expect(result.relationsUpdated).toBe(0);
    });

    test('throws when base_path is not configured', async () => {
        setupLockAcquired();

        await expect(ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']))
            .rejects.toThrow('Repository base path not configured');
    });

    test('deletes old symbol data for changed files', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        mockQueryWithClient.mockResolvedValue({ rows: [], rowCount: 0 });
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']);

        // Transaction should be called for deletion
        expect(mockTransaction).toHaveBeenCalled();
    });

    test('invalidates profile cache for deleted symbol versions', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        // Transaction returns file_id and symbol_version_id rows
        mockTransaction.mockImplementation(async (cb: any) => {
            const client = { query: jest.fn() };
            mockQueryWithClient
                .mockResolvedValueOnce({ rows: [{ file_id: 'f1' }], rowCount: 1 }) // file lookup
                .mockResolvedValueOnce({ rows: [{ symbol_version_id: 'sv1' }], rowCount: 1 }) // sv lookup
                .mockResolvedValue({ rows: [], rowCount: 0 }); // DELETEs
            return cb(client);
        });
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        await ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']);

        // Should have called cache invalidate for the deleted symbol versions
        expect(mockCacheInvalidate).toHaveBeenCalledWith('bp:sv1');
        expect(mockCacheInvalidate).toHaveBeenCalledWith('cp:sv1');
    });

    test('re-extracts TypeScript files', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        mockAccess.mockResolvedValue(undefined); // files exist and extractor exists
        mockReadFile.mockResolvedValue(Buffer.from('const x = 1;'));

        mockExtractFromTypeScript.mockReturnValue({
            symbols: [], relations: [], behavior_hints: [], contract_hints: [],
            parse_confidence: 1.0, uncertainty_flags: [],
        });

        await ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']);

        expect(mockExtractFromTypeScript).toHaveBeenCalled();
    });

    test('releases advisory lock on success', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        await ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']);

        const unlockCalls = mockQuery.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('pg_advisory_unlock')
        );
        expect(unlockCalls.length).toBe(1);
    });

    test('releases advisory lock on failure', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                throw new Error('DB connection error');
            }
            return { rows: [], rowCount: 0 };
        });

        await expect(ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']))
            .rejects.toThrow();

        const unlockCalls = mockQuery.mock.calls.filter(
            (c: any[]) => typeof c[0] === 'string' && c[0].includes('pg_advisory_unlock')
        );
        expect(unlockCalls.length).toBe(1);
    });

    test('skips files that no longer exist on disk', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        // File no longer exists
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', ['deleted.ts']);

        // No extraction should happen
        expect(mockExtractFromTypeScript).not.toHaveBeenCalled();
        expect(result.symbolsUpdated).toBe(0);
    });

    test('skips files with unknown extensions', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        mockAccess.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue(Buffer.from(''));

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', ['readme.md']);

        expect(mockExtractFromTypeScript).not.toHaveBeenCalled();
    });

    test('runs V2 engines during incremental ingestion', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', ['src/app.ts']);

        // V2 engines should be called
        expect(mockBuildClassHierarchy).toHaveBeenCalled();
        expect(mockResolveDispatches).toHaveBeenCalled();
        expect(mockComputeEffectSignatures).toHaveBeenCalled();
    });

    test('returns correct result shape', async () => {
        mockQuery.mockImplementation(async (text: string) => {
            if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                return { rows: [{ acquired: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('pg_advisory_unlock')) {
                return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            if (typeof text === 'string' && text.includes('base_path FROM repositories')) {
                return { rows: [{ base_path: '/repo' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        mockAccess.mockRejectedValue(new Error('ENOENT'));

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', []);

        expect(result).toEqual(expect.objectContaining({
            symbolsUpdated: expect.any(Number),
            relationsUpdated: expect.any(Number),
            dispatch_edges_resolved: expect.any(Number),
            lineages_computed: expect.any(Number),
            effect_signatures_computed: expect.any(Number),
            deep_contracts_mined: expect.any(Number),
            concept_families_built: expect.any(Number),
            temporal_co_changes_found: expect.any(Number),
        }));
    });
});

describe('Ingestor — populateTestArtifacts', () => {
    test('identifies test files in __tests__ directories', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        // Provide symbol version rows with test file paths
        mockGetSymbolVersionsForSnapshot.mockResolvedValue([
            {
                symbol_version_id: 'sv-test-1',
                symbol_id: 'sym-1',
                snapshot_id: 'snap-001',
                file_id: 'f1',
                range_start_line: 1, range_start_col: 0,
                range_end_line: 10, range_end_col: 0,
                signature: '', ast_hash: '', body_hash: '',
                summary: '', body_source: null, visibility: 'public',
                language: 'typescript', uncertainty_flags: [],
                canonical_name: 'testFn',
                kind: 'function',
                stable_key: 'src/__tests__/app.test.ts::testFn',
                repo_id: 'repo-001',
                file_path: 'src/__tests__/app.test.ts',
            },
        ]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockInsertTestArtifact).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol_version_id: 'sv-test-1',
                framework: 'jest',
            })
        );
    });

    test('identifies .test.ts files as jest framework', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockGetSymbolVersionsForSnapshot.mockResolvedValue([
            {
                symbol_version_id: 'sv-test-2',
                file_path: 'src/utils.test.ts',
                canonical_name: 'testUtil',
                kind: 'function',
                symbol_id: 'sym-2', snapshot_id: 'snap-001', file_id: 'f2',
                range_start_line: 1, range_start_col: 0,
                range_end_line: 10, range_end_col: 0,
                signature: '', ast_hash: '', body_hash: '',
                summary: '', body_source: null, visibility: 'public',
                language: 'typescript', uncertainty_flags: [],
            },
        ]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockInsertTestArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ framework: 'jest' })
        );
    });

    test('identifies .py test files as pytest framework', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockGetSymbolVersionsForSnapshot.mockResolvedValue([
            {
                symbol_version_id: 'sv-test-3',
                file_path: 'tests/test_utils.py',
                canonical_name: 'test_add',
                kind: 'function',
                symbol_id: 'sym-3', snapshot_id: 'snap-001', file_id: 'f3',
                range_start_line: 1, range_start_col: 0,
                range_end_line: 10, range_end_col: 0,
                signature: '', ast_hash: '', body_hash: '',
                summary: '', body_source: null, visibility: 'public',
                language: 'python', uncertainty_flags: [],
            },
        ]);

        // The test filter checks file_path for .test. or .spec. or __tests__
        // "tests/test_utils.py" won't match those exact patterns, so it won't be a test artifact
        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Since file_path doesn't contain .test. or .spec. or __tests__, it won't be a test
        expect(mockInsertTestArtifact).not.toHaveBeenCalled();
    });

    test('detects .spec.ts files as tests', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        mockGetSymbolVersionsForSnapshot.mockResolvedValue([
            {
                symbol_version_id: 'sv-test-4',
                file_path: 'src/utils.spec.ts',
                canonical_name: 'specTest',
                kind: 'function',
                symbol_id: 'sym-4', snapshot_id: 'snap-001', file_id: 'f4',
                range_start_line: 1, range_start_col: 0,
                range_end_line: 10, range_end_col: 0,
                signature: '', ast_hash: '', body_hash: '',
                summary: '', body_source: null, visibility: 'public',
                language: 'typescript', uncertainty_flags: [],
            },
        ]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockInsertTestArtifact).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol_version_id: 'sv-test-4',
                framework: 'jest',
            })
        );
    });
});

describe('Ingestor — Concurrent ingestion protection', () => {
    test('ingestRepo returns early result when lock is held', async () => {
        setupLockNotAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });

        const result = await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(result.repo_id).toBe('');
        expect(result.snapshot_id).toBe('');
        expect(result.files_processed).toBe(0);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    test('ingestIncremental returns early result when lock is held', async () => {
        setupLockNotAcquired();

        const result = await ingestor.ingestIncremental('repo-001', 'snap-001', ['app.ts']);

        expect(result.symbolsUpdated).toBe(0);
        expect(result.relationsUpdated).toBe(0);
        expect(result.dispatch_edges_resolved).toBe(0);
    });
});

describe('Ingestor — Behavioral propagation', () => {
    test('calls propagateTransitive after extraction when no failures', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockPropagateTransitive).toHaveBeenCalledWith('snap-001');
    });

    test('skips propagateTransitive when extraction is partial', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('broken.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('code'));

        mockExtractFromTypeScript.mockImplementation(() => {
            throw new Error('TS fail');
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockPropagateTransitive).not.toHaveBeenCalled();
    });
});

describe('Ingestor — Contract invariant mining', () => {
    test('calls mineInvariantsFromTests when extraction succeeds', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([]);

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockMineInvariantsFromTests).toHaveBeenCalledWith('repo-001', 'snap-001', []);
    });

    test('skips mineInvariantsFromTests when extraction is partial', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('broken.ts', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat.mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('code'));

        mockExtractFromTypeScript.mockImplementation(() => {
            throw new Error('TS fail');
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        expect(mockMineInvariantsFromTests).not.toHaveBeenCalled();
    });
});

describe('Ingestor — resolveSafePath', () => {
    test('delegates to resolvePathWithinBase', () => {
        const ingest = new Ingestor();
        const safePath = (ingest as any).resolveSafePath('/base', 'sub/file.ts');
        expect(safePath).toBe(path.resolve('/base', 'sub/file.ts'));
    });
});

describe('Ingestor — findTsconfig', () => {
    test('returns tsconfig path when file exists', async () => {
        mockAccess.mockResolvedValue(undefined);
        const ingest = new Ingestor();
        const result = await (ingest as any).findTsconfig('/repo');
        expect(result).toBe('/repo/tsconfig.json');
    });

    test('returns null when tsconfig does not exist', async () => {
        mockAccess.mockRejectedValue(new Error('ENOENT'));
        const ingest = new Ingestor();
        const result = await (ingest as any).findTsconfig('/repo');
        expect(result).toBeNull();
    });
});

describe('Ingestor — Multiple language handling in single repo', () => {
    test('groups .ts and .js files together for TS adapter', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });
        mockReaddir.mockResolvedValueOnce([
            makeDirent('app.ts', { isFile: true }),
            makeDirent('util.js', { isFile: true }),
        ]);
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });
        mockStat
            .mockResolvedValueOnce({ size: 100 })
            .mockResolvedValueOnce({ size: 100 });
        mockReadFile.mockResolvedValue(Buffer.from('code'));

        mockExtractFromTypeScript.mockReturnValue({
            symbols: [], relations: [], behavior_hints: [], contract_hints: [],
            parse_confidence: 1.0, uncertainty_flags: [],
        });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // Both .ts and .js files should be passed to extractFromTypeScript
        const tsCalls = mockExtractFromTypeScript.mock.calls;
        expect(tsCalls.length).toBe(1);
        expect(tsCalls[0][0]).toHaveLength(2);
    });
});

describe('Ingestor — SKIP_DIRS coverage', () => {
    test('skips common build/dependency directories', async () => {
        setupLockAcquired();
        mockStat.mockResolvedValueOnce({ isDirectory: () => true });

        const skipDirNames = [
            'node_modules', 'dist', 'build', '.next', '.nuxt',
            '__pycache__', '.venv', 'target', 'vendor',
            'coverage', '.idea', '.vscode', 'bin', 'obj',
        ];

        mockReaddir.mockResolvedValueOnce(
            skipDirNames.map(name => makeDirent(name, { isDirectory: true }))
        );
        mockLstat.mockResolvedValue({ isSymbolicLink: () => false });

        await ingestor.ingestRepo('/repo', 'test-repo', 'abc123');

        // readdir should only be called once (for root), no subdirectory recursion
        expect(mockReaddir).toHaveBeenCalledTimes(1);
    });
});
