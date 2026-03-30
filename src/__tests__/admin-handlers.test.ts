/**
 * ContextZero — Admin Handler Tests
 *
 * Tests for admin MCP tool handlers: retention, cleanup, db stats, system info.
 * Validates that handlers correctly delegate to service layer and format results.
 */

const mockQuery = jest.fn();
const mockHealthCheck = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
        healthCheck: () => mockHealthCheck(),
    },
}));

jest.mock('../db-driver/result', () => ({
    firstRow: (r: unknown) => r,
    optionalStringField: jest.fn(),
    parseCountField: (row: Record<string, unknown>, key?: string) => {
        const k = key || 'cnt';
        return typeof row[k] === 'number' ? row[k] : 0;
    },
}));

jest.mock('../db-driver/core_data', () => ({
    coreDataService: {},
}));

jest.mock('../analysis-engine', () => ({ structuralGraphEngine: {} }));
jest.mock('../analysis-engine/behavioral', () => ({ behavioralEngine: {} }));
jest.mock('../analysis-engine/contracts', () => ({ contractEngine: {} }));
jest.mock('../analysis-engine/blast-radius', () => ({ blastRadiusEngine: {} }));
jest.mock('../analysis-engine/capsule-compiler', () => ({ capsuleCompiler: {} }));
jest.mock('../analysis-engine/uncertainty', () => ({ uncertaintyTracker: {} }));
jest.mock('../homolog-engine', () => ({ homologInferenceEngine: {} }));
jest.mock('../transactional-editor', () => ({ transactionalChangeEngine: {} }));
jest.mock('../ingestor', () => ({ ingestor: {} }));
jest.mock('../path-security', () => ({ resolvePathWithinBase: jest.fn() }));
jest.mock('../workspace-native', () => ({
    buildNativeCodebaseOverview: jest.fn(),
    deriveWorkspaceSnapshotIdentity: jest.fn(),
    ensureAllowedRepoPath: jest.fn(),
    searchWorkspaceCode: jest.fn(),
    searchWorkspaceSymbols: jest.fn(),
}));

jest.mock('../cache', () => ({
    homologCache: { stats: () => ({ hits: 10, misses: 5, size: 15 }) },
    destroyAllCaches: jest.fn(),
    symbolCache: { stats: () => ({ hits: 100, misses: 20, size: 80 }) },
    profileCache: { stats: () => ({ hits: 50, misses: 10, size: 40 }) },
    capsuleCache: { stats: () => ({ hits: 5, misses: 2, size: 3 }) },
    queryCache: { stats: () => ({ hits: 200, misses: 30, size: 100 }) },
}));

jest.mock('../config', () => ({
    retention: {
        snapshotMaxAgeDays: 90,
        maxSnapshotsPerRepo: 50,
        staleTransactionTimeoutMinutes: 60,
        orphanCleanupEnabled: true,
        retentionIntervalMinutes: 360,
        retentionEnabled: true,
    },
    features: { enableMcpAuth: false, mcpSecret: '' },
    logging: { level: 'info' },
    server: { version: '2.0.0' },
}));

jest.mock('../logger', () => ({
    Logger: jest.fn().mockImplementation(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        startTimer: jest.fn(() => jest.fn()),
    })),
}));

// Must import after mocks
import {
    handleAdminDbStats,
    handleAdminSystemInfo,
} from '../mcp-bridge/handlers';

const mcpLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

beforeEach(() => {
    mockQuery.mockReset();
    mockHealthCheck.mockReset();
});

// ────────── handleAdminDbStats ──────────

describe('handleAdminDbStats', () => {
    it('returns table stats, db size, and connection info', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [{ table_name: 'symbols', row_count: 5000, total_size: '12 MB' }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({
                rows: [{ index_name: 'idx_test', table_name: 'symbols', scans: 0, size: '1 MB' }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({
                rows: [{ db_size: '250 MB' }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({
                rows: [{ active: 3, idle: 17, idle_in_transaction: 0, total: 20 }],
                rowCount: 1,
            });

        const result = await handleAdminDbStats({}, mcpLog);

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.database_size).toBe('250 MB');
        expect(data.tables).toHaveLength(1);
        expect(data.tables[0].table_name).toBe('symbols');
    });
});

// ────────── handleAdminSystemInfo ──────────

describe('handleAdminSystemInfo', () => {
    it('returns server stats, entity counts, and cache stats', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ count: 5 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ count: 20 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ count: 1500 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ count: 8000 }], rowCount: 1 });

        mockHealthCheck.mockResolvedValueOnce({
            connected: true,
            latency_ms: 2,
        });

        const result = await handleAdminSystemInfo({}, mcpLog);

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.server.uptime_seconds).toBeGreaterThanOrEqual(0);
        expect(data.database.connected).toBe(true);
        expect(data.database.repositories).toBe(5);
        expect(data.caches.symbol.hits).toBe(100);
    });
});
