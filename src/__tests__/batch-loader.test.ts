/**
 * BatchLoader Unit Tests
 *
 * Tests:
 * - Chunking at CHUNK_SIZE boundary (exactly 5000, 5001, crosses boundary)
 * - Empty array handling
 * - Single item
 * - SQL injection prevention (allowlist validation)
 * - Pagination (loadSymbolVersionsBySnapshotPaginated)
 * - Per-pass caching
 * - LIMIT safety on unbounded loads
 */

const mockQuery = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
    },
}));

import { BatchLoader } from '../db-driver/batch-loader';

beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('BatchLoader — chunkedInQuery', () => {

    test('empty array returns empty result', async () => {
        const loader = new BatchLoader();
        const result = await loader.loadBehavioralProfiles([]);
        expect(result.size).toBe(0);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('single item makes one query', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ behavior_profile_id: 'bp-1', symbol_version_id: 'sv-1', purity_class: 'pure', resource_touches: [] }],
            rowCount: 1,
        });
        const loader = new BatchLoader();
        const result = await loader.loadBehavioralProfiles(['sv-1']);
        expect(result.size).toBe(1);
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('exactly CHUNK_SIZE (5000) items makes one query', async () => {
        const ids = Array.from({ length: 5000 }, (_, i) => `sv-${i}`);
        mockQuery.mockResolvedValueOnce({ rows: ids.map(id => ({ behavior_profile_id: `bp-${id}`, symbol_version_id: id })), rowCount: 5000 });

        const loader = new BatchLoader();
        const result = await loader.loadBehavioralProfiles(ids);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(result.size).toBe(5000);
    });

    test('5001 items splits into 2 queries (5000 + 1)', async () => {
        const ids = Array.from({ length: 5001 }, (_, i) => `sv-${i}`);
        mockQuery
            .mockResolvedValueOnce({ rows: ids.slice(0, 5000).map(id => ({ behavior_profile_id: `bp-${id}`, symbol_version_id: id })), rowCount: 5000 })
            .mockResolvedValueOnce({ rows: [{ behavior_profile_id: `bp-${ids[5000]}`, symbol_version_id: ids[5000] }], rowCount: 1 });

        const loader = new BatchLoader();
        const result = await loader.loadBehavioralProfiles(ids);
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(result.size).toBe(5001);
    });

    test('10001 items splits into 3 queries', async () => {
        const ids = Array.from({ length: 10001 }, (_, i) => `sv-${i}`);
        mockQuery
            .mockResolvedValueOnce({ rows: ids.slice(0, 5000).map(id => ({ behavior_profile_id: `bp-${id}`, symbol_version_id: id })), rowCount: 5000 })
            .mockResolvedValueOnce({ rows: ids.slice(5000, 10000).map(id => ({ behavior_profile_id: `bp-${id}`, symbol_version_id: id })), rowCount: 5000 })
            .mockResolvedValueOnce({ rows: [{ behavior_profile_id: `bp-${ids[10000]}`, symbol_version_id: ids[10000] }], rowCount: 1 });

        const loader = new BatchLoader();
        const result = await loader.loadBehavioralProfiles(ids);
        expect(mockQuery).toHaveBeenCalledTimes(3);
        expect(result.size).toBe(10001);
    });
});

describe('BatchLoader — SQL injection prevention', () => {

    test('rejects disallowed table name', async () => {
        const loader = new BatchLoader();
        // Access the private chunkedInQuery via a behavioral profile call won't trigger it,
        // so test via the public interface — the allowlist only allows known tables.
        // The constructor only exposes safe methods, so we verify the allowlist exists.
        // Direct test: attempt to access a table not in the allowlist
        await expect(
            (loader as any).chunkedInQuery('users; DROP TABLE symbols; --', 'id', ['1'])
        ).rejects.toThrow('disallowed table/column');
    });

    test('rejects disallowed column name', async () => {
        const loader = new BatchLoader();
        await expect(
            (loader as any).chunkedInQuery('behavioral_profiles', 'id; DROP TABLE--', ['1'])
        ).rejects.toThrow('disallowed table/column');
    });

    test('allows valid table/column combination', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ symbol_version_id: 'sv-1' }], rowCount: 1 });
        const loader = new BatchLoader();
        const result = await (loader as any).chunkedInQuery('behavioral_profiles', 'symbol_version_id', ['sv-1']);
        expect(result.length).toBe(1);
    });
});

describe('BatchLoader — per-pass caching', () => {

    test('second call returns cached result without DB query', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ behavior_profile_id: 'bp-1', symbol_version_id: 'sv-1', purity_class: 'pure', resource_touches: [] }],
            rowCount: 1,
        });

        const loader = new BatchLoader();
        await loader.loadBehavioralProfiles(['sv-1']);
        expect(mockQuery).toHaveBeenCalledTimes(1);

        // Second call — should hit cache
        mockQuery.mockClear();
        const result = await loader.loadBehavioralProfiles(['sv-1']);
        expect(mockQuery).not.toHaveBeenCalled();
        expect(result.size).toBe(1);
    });

    test('different loader instances do NOT share cache', async () => {
        mockQuery.mockResolvedValue({
            rows: [{ behavior_profile_id: 'bp-1', symbol_version_id: 'sv-1', purity_class: 'pure', resource_touches: [] }],
            rowCount: 1,
        });

        const loader1 = new BatchLoader();
        await loader1.loadBehavioralProfiles(['sv-1']);

        const loader2 = new BatchLoader();
        await loader2.loadBehavioralProfiles(['sv-1']);

        // Both loaders should have made their own DB call
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });
});

describe('BatchLoader — loadSymbolVersionsBySnapshot', () => {

    test('includes LIMIT in query for safety', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const loader = new BatchLoader();
        await loader.loadSymbolVersionsBySnapshot('snap-1');
        const sql = mockQuery.mock.calls[0][0] as string;
        expect(sql).toContain('LIMIT');
    });

    test('caches snapshot result', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ symbol_version_id: 'sv-1' }], rowCount: 1 });
        const loader = new BatchLoader();
        await loader.loadSymbolVersionsBySnapshot('snap-1');
        mockQuery.mockClear();
        const result = await loader.loadSymbolVersionsBySnapshot('snap-1');
        expect(mockQuery).not.toHaveBeenCalled();
        expect(result.length).toBe(1);
    });
});

describe('BatchLoader — paginated loading', () => {

    test('returns next cursor when more rows exist', async () => {
        // Request page of 2, return 3 (one extra)
        mockQuery.mockResolvedValueOnce({
            rows: [
                { symbol_version_id: 'sv-1' },
                { symbol_version_id: 'sv-2' },
                { symbol_version_id: 'sv-3' },
            ],
            rowCount: 3,
        });

        const loader = new BatchLoader();
        const result = await loader.loadSymbolVersionsBySnapshotPaginated('snap-1', { pageSize: 2 });
        expect(result.rows.length).toBe(2);
        expect(result.nextCursor).toBe('sv-2');
    });

    test('returns null cursor when no more rows', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ symbol_version_id: 'sv-1' }],
            rowCount: 1,
        });

        const loader = new BatchLoader();
        const result = await loader.loadSymbolVersionsBySnapshotPaginated('snap-1', { pageSize: 10 });
        expect(result.rows.length).toBe(1);
        expect(result.nextCursor).toBeNull();
    });

    test('uses afterId for cursor-based pagination', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const loader = new BatchLoader();
        await loader.loadSymbolVersionsBySnapshotPaginated('snap-1', { afterId: 'sv-100' });
        const sql = mockQuery.mock.calls[0][0] as string;
        expect(sql).toContain('> $2');
    });
});
