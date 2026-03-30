/**
 * ContextZero — Service Layer Tests
 *
 * Mock-based unit tests for all service layer functions.
 * Each service is tested against mocked db.query responses
 * with realistic row shapes matching the actual SQL projections.
 */

const mockQuery = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
        transaction: jest.fn(),
    },
}));

jest.mock('../analysis-engine/behavioral', () => ({
    behavioralEngine: {
        getProfile: jest.fn(),
    },
}));

jest.mock('../analysis-engine/contracts', () => ({
    contractEngine: {
        getProfile: jest.fn(),
    },
}));

jest.mock('../analysis-engine/uncertainty', () => ({
    uncertaintyTracker: {
        getSnapshotUncertainty: jest.fn(),
    },
}));

jest.mock('../analysis-engine/blast-radius', () => ({
    blastRadiusEngine: {
        computeBlastRadius: jest.fn(),
    },
}));

jest.mock('../db-driver/core_data', () => ({
    coreDataService: {
        getRepository: jest.fn(),
    },
}));

jest.mock('../path-security', () => ({
    resolveExistingPath: jest.fn((p: string) => p),
    resolvePathWithinBase: jest.fn((_base: string, rel: string) => ({
        realPath: `/repo/${rel}`,
    })),
}));

jest.mock('fs/promises', () => ({
    readFile: jest.fn(),
}));

import { resolveSymbol, getSymbolDetails } from '../services/symbol-service';
import { getCodebaseOverview } from '../services/overview-service';
import { listRepos, listSnapshots } from '../services/repo-service';
import { searchCode } from '../services/search-service';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { uncertaintyTracker } from '../analysis-engine/uncertainty';
import { coreDataService } from '../db-driver/core_data';
import * as fsp from 'fs/promises';

// ────────────────────────────────────────────────────────────────────────────
// resolveSymbol
// ────────────────────────────────────────────────────────────────────────────
describe('resolveSymbol', () => {
    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('returns ranked symbols for a valid query', async () => {
        const rows = [
            {
                symbol_id: 'sym-001',
                canonical_name: 'processPayment',
                kind: 'function',
                stable_key: 'mod::processPayment',
                symbol_version_id: 'sv-001',
                signature: '(amount: number, currency: string) => Promise<Receipt>',
                visibility: 'public',
                file_path: 'src/billing/payments.ts',
                name_sim: 0.85,
            },
            {
                symbol_id: 'sym-002',
                canonical_name: 'processRefund',
                kind: 'function',
                stable_key: 'mod::processRefund',
                symbol_version_id: 'sv-002',
                signature: '(receiptId: string) => Promise<void>',
                visibility: 'public',
                file_path: 'src/billing/refunds.ts',
                name_sim: 0.62,
            },
        ];

        mockQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

        const result = await resolveSymbol('processPayment', 'repo-abc');

        expect(result.symbols).toHaveLength(2);
        expect(result.count).toBe(2);
        expect(result.symbols[0]!.canonical_name).toBe('processPayment');
        expect(result.symbols[0]!.name_sim).toBeGreaterThan(result.symbols[1]!.name_sim);
        // Verify the SQL uses similarity and repo_id
        expect(mockQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('similarity');
        expect(params[0]).toBe('processPayment');
        expect(params[1]).toBe('repo-abc');
    });

    test('returns empty array when no matches found', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await resolveSymbol('nonExistentFn', 'repo-abc');

        expect(result.symbols).toEqual([]);
        expect(result.count).toBe(0);
    });

    test('applies kind_filter when provided', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await resolveSymbol('Handler', 'repo-abc', undefined, 'class');

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('s.kind = $');
        expect(params).toContain('class');
    });

    test('respects limit parameter', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await resolveSymbol('util', 'repo-abc', undefined, undefined, 5);

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('LIMIT');
        // limit is the last parameter
        expect(params[params.length - 1]).toBe(5);
    });

    test('includes snapshot_id filter when provided', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await resolveSymbol('main', 'repo-abc', 'snap-123');

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('sv.snapshot_id');
        expect(params).toContain('snap-123');
    });

    test('applies both snapshot_id and kind_filter together', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await resolveSymbol('create', 'repo-abc', 'snap-123', 'method', 3);

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('sv.snapshot_id');
        expect(sql).toContain('s.kind');
        expect(params).toContain('snap-123');
        expect(params).toContain('method');
        expect(params[params.length - 1]).toBe(3);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// getSymbolDetails
// ────────────────────────────────────────────────────────────────────────────
describe('getSymbolDetails', () => {
    beforeEach(() => {
        mockQuery.mockReset();
        (behavioralEngine.getProfile as jest.Mock).mockReset();
        (contractEngine.getProfile as jest.Mock).mockReset();
    });

    test('throws not found for unknown symbol_version_id', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await expect(getSymbolDetails('sv-nonexistent'))
            .rejects
            .toThrow('Symbol version not found');
    });

    test('returns symbol with behavioral/contract profiles in summary mode', async () => {
        const svRow = {
            symbol_version_id: 'sv-100',
            canonical_name: 'UserService.create',
            kind: 'method',
            stable_key: 'UserService::create',
            repo_id: 'repo-1',
            signature: '(data: UserInput) => Promise<User>',
            file_path: 'src/services/user.ts',
        };

        mockQuery.mockResolvedValueOnce({ rows: [svRow], rowCount: 1 });
        (behavioralEngine.getProfile as jest.Mock).mockResolvedValueOnce({ purity_class: 'read_write' });
        (contractEngine.getProfile as jest.Mock).mockResolvedValueOnce({ input_contract: { type: 'object' } });

        const result = await getSymbolDetails('sv-100', 'summary');

        expect(result.symbol).toBeDefined();
        expect(result.behavioral_profile).toEqual({ purity_class: 'read_write' });
        expect(result.contract_profile).toEqual({ input_contract: { type: 'object' } });
    });

    test('returns only signature fields in signature mode', async () => {
        const svRow = {
            symbol_version_id: 'sv-200',
            canonical_name: 'parse',
            kind: 'function',
            stable_key: 'mod::parse',
            signature: '(input: string) => AST',
            file_path: 'src/parser.ts',
            body_source: 'function parse(input) { ... }',
        };

        mockQuery.mockResolvedValueOnce({ rows: [svRow], rowCount: 1 });

        const result = await getSymbolDetails('sv-200', 'signature');

        expect(result.symbol).toEqual({
            symbol_version_id: 'sv-200',
            canonical_name: 'parse',
            kind: 'function',
            signature: '(input: string) => AST',
            file_path: 'src/parser.ts',
        });
        // No behavioral/contract profiles requested in signature mode
        expect(result.behavioral_profile).toBeUndefined();
        expect(result.contract_profile).toBeUndefined();
    });
});

// ────────────────────────────────────────────────────────────────────────────
// getCodebaseOverview
// ────────────────────────────────────────────────────────────────────────────
describe('getCodebaseOverview', () => {
    beforeEach(() => {
        mockQuery.mockReset();
        (uncertaintyTracker.getSnapshotUncertainty as jest.Mock).mockReset();
    });

    test('returns complete overview structure', async () => {
        // Promise.all batch 1: langResult (GROUP BY language) + pathResult (SELECT path)
        mockQuery.mockResolvedValueOnce({
            rows: [
                { language: 'typescript', count: '2' },
                { language: 'css', count: '1' },
            ],
            rowCount: 2,
        });
        mockQuery.mockResolvedValueOnce({
            rows: [
                { path: 'src/index.ts' },
                { path: 'src/utils/helpers.ts' },
                { path: 'src/styles/main.css' },
            ],
            rowCount: 3,
        });

        // Promise.all batch 2: kindResult + totalSymbolResult + publicResult
        mockQuery.mockResolvedValueOnce({
            rows: [
                { kind: 'function', count: '2' },
                { kind: 'class', count: '1' },
            ],
            rowCount: 2,
        });
        mockQuery.mockResolvedValueOnce({
            rows: [{ count: '3' }],
            rowCount: 1,
        });
        mockQuery.mockResolvedValueOnce({
            rows: [
                { kind: 'function', canonical_name: 'main', file_path: 'src/index.ts' },
                { kind: 'class', canonical_name: 'App', file_path: 'src/index.ts' },
            ],
            rowCount: 2,
        });

        // Query 3: behavioral purity distribution (GROUP BY)
        mockQuery.mockResolvedValueOnce({
            rows: [
                { purity_class: 'pure', cnt: '1' },
                { purity_class: 'read_only', cnt: '2' },
            ],
            rowCount: 2,
        });

        // Query 4: risky symbols
        mockQuery.mockResolvedValueOnce({
            rows: [
                {
                    canonical_name: 'saveData',
                    kind: 'function',
                    path: 'src/db.ts',
                    purity_class: 'side_effecting',
                    network_calls: ['fetch'],
                    db_writes: ['INSERT'],
                    file_io: [],
                },
            ],
            rowCount: 1,
        });

        // Query 5: test coverage
        mockQuery.mockResolvedValueOnce({
            rows: [{ tested: '2' }],
            rowCount: 1,
        });

        // Uncertainty
        (uncertaintyTracker.getSnapshotUncertainty as jest.Mock).mockResolvedValueOnce({
            overall_confidence: 0.85,
            total_annotations: 3,
            by_source: { parse_error: 1, dynamic_dispatch: 2 },
            most_uncertain_symbols: [{ symbol_version_id: 'sv-1', flag_count: 2 }],
        });

        const overview = await getCodebaseOverview('snap-001');

        // summary
        expect(overview.summary.total_files).toBe(3);
        expect(overview.summary.total_symbols).toBe(3);
        expect(overview.summary.languages).toEqual({ typescript: 2, css: 1 });
        expect(overview.summary.directories.length).toBeGreaterThan(0);

        // symbols
        expect(overview.symbols.by_kind).toEqual({ function: 2, class: 1 });
        expect(overview.symbols.public_api_count).toBe(2);

        // behavioral
        expect(overview.behavioral_profile.purity_distribution).toEqual({ pure: 1, read_only: 2 });
        expect(overview.behavioral_profile.profiled_count).toBe(3);
        expect(overview.behavioral_profile.high_risk_symbols).toHaveLength(1);
        expect(overview.behavioral_profile.high_risk_symbols[0]!.risks).toContain('network:fetch');
        expect(overview.behavioral_profile.high_risk_symbols[0]!.risks).toContain('db_write:INSERT');

        // test coverage
        expect(overview.test_coverage.symbols_tested).toBe(2);
        expect(overview.test_coverage.symbols_total).toBe(3);
        expect(overview.test_coverage.coverage_percent).toBe('66.7%');

        // uncertainty
        expect(overview.uncertainty.overall_confidence).toBe(0.85);
        expect(overview.uncertainty.total_annotations).toBe(3);
    });

    test('handles empty snapshot with 0 files and 0 symbols', async () => {
        // Batch 1: langResult + pathResult
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Batch 2: kindResult + totalSymbolResult + publicResult
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Query 3: behavioral purity distribution
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Query 4: no risky symbols
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        // Query 5: test coverage
        mockQuery.mockResolvedValueOnce({ rows: [{ tested: '0' }], rowCount: 1 });
        // Uncertainty
        (uncertaintyTracker.getSnapshotUncertainty as jest.Mock).mockResolvedValueOnce({
            overall_confidence: 1.0,
            total_annotations: 0,
            by_source: {},
            most_uncertain_symbols: [],
        });

        const overview = await getCodebaseOverview('snap-empty');

        expect(overview.summary.total_files).toBe(0);
        expect(overview.summary.total_symbols).toBe(0);
        expect(overview.summary.languages).toEqual({});
        expect(overview.summary.directories).toEqual([]);
        expect(overview.symbols.by_kind).toEqual({});
        expect(overview.symbols.public_api_count).toBe(0);
        expect(overview.symbols.entry_points).toEqual([]);
        expect(overview.behavioral_profile.high_risk_symbols).toEqual([]);
        expect(overview.behavioral_profile.profiled_count).toBe(0);
        expect(overview.test_coverage.symbols_tested).toBe(0);
        expect(overview.test_coverage.coverage_percent).toBe('0%');
        expect(overview.uncertainty.overall_confidence).toBe(1.0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// listRepos
// ────────────────────────────────────────────────────────────────────────────
describe('listRepos', () => {
    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('returns repos array with correct limit/offset', async () => {
        const repos = [
            { repo_id: 'r-1', name: 'alpha', base_path: '/repos/alpha', updated_at: '2025-01-01' },
            { repo_id: 'r-2', name: 'beta', base_path: '/repos/beta', updated_at: '2025-01-02' },
        ];
        mockQuery.mockResolvedValueOnce({ rows: repos, rowCount: 2 });

        const result = await listRepos(10, 0);

        expect(result.repositories).toHaveLength(2);
        expect(result.count).toBe(2);
        expect(result.repositories[0]).toHaveProperty('repo_id', 'r-1');
        expect(result.repositories[1]).toHaveProperty('name', 'beta');

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('ORDER BY updated_at DESC');
        expect(sql).toContain('LIMIT');
        expect(params).toEqual([10, 0]);
    });

    test('returns empty result when no repos exist', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await listRepos();

        expect(result.repositories).toEqual([]);
        expect(result.count).toBe(0);
    });

    test('applies default limit and offset', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await listRepos();

        const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([20, 0]);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// listSnapshots
// ────────────────────────────────────────────────────────────────────────────
describe('listSnapshots', () => {
    beforeEach(() => {
        mockQuery.mockReset();
    });

    test('returns snapshots for a given repo_id', async () => {
        const snapshots = [
            { snapshot_id: 'snap-1', repo_id: 'repo-1', indexed_at: '2025-03-01T00:00:00Z', status: 'complete' },
            { snapshot_id: 'snap-2', repo_id: 'repo-1', indexed_at: '2025-02-15T00:00:00Z', status: 'complete' },
        ];
        mockQuery.mockResolvedValueOnce({ rows: snapshots, rowCount: 2 });

        const result = await listSnapshots('repo-1');

        expect(result.snapshots).toHaveLength(2);
        expect(result.count).toBe(2);
        expect(result.snapshots[0]).toHaveProperty('snapshot_id', 'snap-1');

        const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('repo_id = $1');
        expect(sql).toContain('ORDER BY indexed_at DESC');
        expect(params[0]).toBe('repo-1');
    });

    test('returns empty when repo has no snapshots', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await listSnapshots('repo-no-snaps');

        expect(result.snapshots).toEqual([]);
        expect(result.count).toBe(0);
    });

    test('passes limit and offset to query', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await listSnapshots('repo-1', 5, 10);

        const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual(['repo-1', 5, 10]);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// searchCode
// ────────────────────────────────────────────────────────────────────────────
describe('searchCode', () => {
    beforeEach(() => {
        mockQuery.mockReset();
        (coreDataService.getRepository as jest.Mock).mockReset();
        (fsp.readFile as jest.Mock).mockReset();
    });

    test('returns matches with context lines', async () => {
        (coreDataService.getRepository as jest.Mock).mockResolvedValueOnce({
            repo_id: 'repo-1',
            base_path: '/repos/alpha',
        });

        mockQuery.mockResolvedValueOnce({
            rows: [{ path: 'src/index.ts' }],
            rowCount: 1,
        });

        const fileContent = [
            'import express from "express";',
            '',
            'const app = express();',
            'app.listen(3000);',
            'console.log("running");',
        ].join('\n');

        (fsp.readFile as jest.Mock).mockResolvedValueOnce(fileContent);

        const result = await searchCode('repo-1', 'express');

        expect(result.pattern).toBe('express');
        expect(result.total_matches).toBeGreaterThanOrEqual(1);
        expect(result.matches.length).toBeGreaterThanOrEqual(1);
        expect(result.matches[0]!.file).toBe('src/index.ts');
        expect(result.matches[0]!.line).toBe(1);
        expect(result.matches[0]!.context).toContain('express');
    });

    test('handles regex patterns', async () => {
        (coreDataService.getRepository as jest.Mock).mockResolvedValueOnce({
            repo_id: 'repo-1',
            base_path: '/repos/alpha',
        });

        mockQuery.mockResolvedValueOnce({
            rows: [{ path: 'src/utils.ts' }],
            rowCount: 1,
        });

        const fileContent = [
            'function add(a: number, b: number) { return a + b; }',
            'function subtract(a: number, b: number) { return a - b; }',
            'const PI = 3.14;',
        ].join('\n');

        (fsp.readFile as jest.Mock).mockResolvedValueOnce(fileContent);

        const result = await searchCode('repo-1', 'function\\s+\\w+');

        expect(result.total_matches).toBe(2);
        expect(result.matches[0]!.match).toContain('function');
        expect(result.matches[1]!.match).toContain('function');
    });

    test('returns empty for no matches', async () => {
        (coreDataService.getRepository as jest.Mock).mockResolvedValueOnce({
            repo_id: 'repo-1',
            base_path: '/repos/alpha',
        });

        mockQuery.mockResolvedValueOnce({
            rows: [{ path: 'src/empty.ts' }],
            rowCount: 1,
        });

        (fsp.readFile as jest.Mock).mockResolvedValueOnce('const x = 1;\n');

        const result = await searchCode('repo-1', 'ZZZZNOTFOUND');

        expect(result.total_matches).toBe(0);
        expect(result.matches).toEqual([]);
    });

    test('throws not found when repository does not exist', async () => {
        (coreDataService.getRepository as jest.Mock).mockResolvedValueOnce(null);

        await expect(searchCode('bad-repo', 'test'))
            .rejects
            .toThrow('Repository not found');
    });

    test('respects maxResults option', async () => {
        (coreDataService.getRepository as jest.Mock).mockResolvedValueOnce({
            repo_id: 'repo-1',
            base_path: '/repos/alpha',
        });

        mockQuery.mockResolvedValueOnce({
            rows: [{ path: 'src/big.ts' }],
            rowCount: 1,
        });

        // File with many matching lines
        const lines = Array.from({ length: 50 }, (_, i) => `const val${i} = "match";`);
        (fsp.readFile as jest.Mock).mockResolvedValueOnce(lines.join('\n'));

        const result = await searchCode('repo-1', 'match', { maxResults: 3 });

        expect(result.total_matches).toBe(3);
        expect(result.matches).toHaveLength(3);
    });
});
