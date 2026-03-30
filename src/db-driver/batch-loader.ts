/**
 * ContextZero — Batch Query Layer
 *
 * Per-request/per-pass batch loader for efficient bulk DB queries.
 * Uses parameterized IN clauses to batch-load behavioral profiles,
 * contract profiles, and symbol versions.
 *
 * Instantiate per-request/per-pass (not singleton) to prevent stale data.
 * Includes an internal cache Map to avoid re-fetching within the same pass.
 *
 * Automatic chunking: splits large ID sets into chunks of CHUNK_SIZE
 * to stay within PostgreSQL's parameter limit (~32768).
 */

import { db } from './index';
import { validateRows, validateSymbolVersionRow, validateBehavioralProfile, validateContractProfile } from './result';
import type { SymbolVersionRow } from './result';
import type { BehavioralProfile, ContractProfile } from '../types';
import { Logger } from '../logger';

const log = new Logger('batch-loader');

/** Max parameters per IN clause to stay within PostgreSQL limits */
const CHUNK_SIZE = 5000;

export class BatchLoader {
    /** Internal per-pass cache to avoid re-fetching within the same pass */
    private behavioralCache = new Map<string, BehavioralProfile>();
    private contractCache = new Map<string, ContractProfile>();
    private symbolVersionCache = new Map<string, SymbolVersionRow[]>();

    /** Allowed table/column combinations — prevents SQL injection */
    private static readonly ALLOWED_QUERIES: Record<string, string[]> = {
        'behavioral_profiles': ['symbol_version_id'],
        'contract_profiles': ['symbol_version_id'],
        'symbol_versions': ['symbol_version_id', 'symbol_id'],
    };

    /**
     * Execute a chunked IN query against a table keyed by symbol_version_id.
     * Splits large ID arrays into chunks of CHUNK_SIZE to stay within
     * PostgreSQL's parameter limit. Returns all matched rows merged.
     *
     * Table and column names are validated against an allowlist to prevent
     * SQL injection — they cannot be parameterized in PostgreSQL.
     */
    private async chunkedInQuery<T>(
        table: string,
        column: string,
        ids: string[],
        rowValidator?: (row: Record<string, unknown>) => T | null,
        context?: string,
    ): Promise<T[]> {
        if (ids.length === 0) return [];

        // Validate table/column against allowlist
        const allowedCols = BatchLoader.ALLOWED_QUERIES[table];
        if (!allowedCols || !allowedCols.includes(column)) {
            throw new Error(`BatchLoader: disallowed table/column: ${table}.${column}`);
        }

        const allRows: T[] = [];
        let failedChunks = 0;
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
            try {
                const result = await db.query(
                    `SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`,
                    chunk
                );
                if (rowValidator) {
                    for (const raw of result.rows) {
                        const validated = rowValidator(raw as Record<string, unknown>);
                        if (validated) allRows.push(validated);
                    }
                } else {
                    allRows.push(...(result.rows as T[]));
                }
            } catch (err) {
                failedChunks++;
                log.warn('chunkedInQuery: chunk query failed, skipping chunk', {
                    table, column, chunkIndex: Math.floor(i / CHUNK_SIZE),
                    chunkSize: chunk.length, error: (err as Error).message,
                });
            }
        }
        if (failedChunks > 0) {
            log.warn(`chunkedInQuery: ${failedChunks} chunk(s) failed`, {
                table, column, context, totalChunks: Math.ceil(ids.length / CHUNK_SIZE),
            });
        }
        return allRows;
    }

    /**
     * Batch-load behavioral profiles for multiple symbol version IDs.
     * Uses chunked parameterized IN clauses for efficient bulk loading.
     * Results are cached for the lifetime of this BatchLoader instance.
     */
    public async loadBehavioralProfiles(svIds: string[]): Promise<Map<string, BehavioralProfile>> {
        const result = new Map<string, BehavioralProfile>();
        const uncachedIds: string[] = [];

        // Return cached entries and identify uncached ones
        for (const id of svIds) {
            const cached = this.behavioralCache.get(id);
            if (cached) {
                result.set(id, cached);
            } else {
                uncachedIds.push(id);
            }
        }

        if (uncachedIds.length === 0) return result;

        const rows = await this.chunkedInQuery<BehavioralProfile>(
            'behavioral_profiles', 'symbol_version_id', uncachedIds,
            validateBehavioralProfile, 'loadBehavioralProfiles',
        );

        for (const row of rows) {
            result.set(row.symbol_version_id, row);
            this.behavioralCache.set(row.symbol_version_id, row);
        }

        log.debug('Batch loaded behavioral profiles', {
            requested: svIds.length,
            cached: svIds.length - uncachedIds.length,
            fetched: rows.length,
        });

        return result;
    }

    /**
     * Batch-load contract profiles for multiple symbol version IDs.
     * Uses chunked parameterized IN clauses for efficient bulk loading.
     * Results are cached for the lifetime of this BatchLoader instance.
     */
    public async loadContractProfiles(svIds: string[]): Promise<Map<string, ContractProfile>> {
        const result = new Map<string, ContractProfile>();
        const uncachedIds: string[] = [];

        // Return cached entries and identify uncached ones
        for (const id of svIds) {
            const cached = this.contractCache.get(id);
            if (cached) {
                result.set(id, cached);
            } else {
                uncachedIds.push(id);
            }
        }

        if (uncachedIds.length === 0) return result;

        const rows = await this.chunkedInQuery<ContractProfile>(
            'contract_profiles', 'symbol_version_id', uncachedIds,
            validateContractProfile, 'loadContractProfiles',
        );

        for (const row of rows) {
            result.set(row.symbol_version_id, row);
            this.contractCache.set(row.symbol_version_id, row);
        }

        log.debug('Batch loaded contract profiles', {
            requested: svIds.length,
            cached: svIds.length - uncachedIds.length,
            fetched: rows.length,
        });

        return result;
    }

    /**
     * Bulk-load all symbol versions for a given snapshot.
     * Uses the same query pattern as CoreDataService.getSymbolVersionsForSnapshot
     * but caches the result for re-use within the same pass.
     *
     * WARNING: This loads ALL rows into memory. For snapshots with 50K+ symbols,
     * prefer loadSymbolVersionsBySnapshotPaginated() which streams results in
     * cursor-based pages.
     */
    /** Hard ceiling on unbounded snapshot loads — prevents OOM on huge repos */
    private static readonly MAX_SNAPSHOT_LOAD = 50_000;

    public async loadSymbolVersionsBySnapshot(snapshotId: string): Promise<SymbolVersionRow[]> {
        const cached = this.symbolVersionCache.get(snapshotId);
        if (cached) return cached;

        const queryResult = await db.query(`
            SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
            ORDER BY sv.symbol_version_id
            LIMIT $2
        `, [snapshotId, BatchLoader.MAX_SNAPSHOT_LOAD]);

        const rows = validateRows(queryResult.rows, validateSymbolVersionRow, 'batchLoader.loadSymbolVersionsBySnapshot');

        if (rows.length >= BatchLoader.MAX_SNAPSHOT_LOAD) {
            log.warn('loadSymbolVersionsBySnapshot hit safety LIMIT — results truncated. Use loadSymbolVersionsBySnapshotPaginated() for repos with 50K+ symbols.', {
                snapshotId,
                limit: BatchLoader.MAX_SNAPSHOT_LOAD,
                returned: rows.length,
            });
        }

        this.symbolVersionCache.set(snapshotId, rows);

        log.debug('Batch loaded symbol versions for snapshot', {
            snapshotId,
            count: rows.length,
        });

        return rows;
    }

    /**
     * Cursor-based paginated loading of symbol versions for a snapshot.
     * Yields pages of rows without holding the full result set in memory.
     * Each page returns up to `pageSize` rows and a cursor for the next page.
     *
     * Results are NOT cached (each page is fetched fresh) since the purpose
     * is to avoid holding the full dataset in memory.
     */
    public async loadSymbolVersionsBySnapshotPaginated(
        snapshotId: string,
        options?: { pageSize?: number; afterId?: string }
    ): Promise<{ rows: SymbolVersionRow[]; nextCursor: string | null }> {
        const pageSize = options?.pageSize ?? 1000;
        const afterId = options?.afterId ?? null;

        let sql = `
            SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
        `;
        const params: unknown[] = [snapshotId];

        if (afterId) {
            sql += ` AND sv.symbol_version_id > $2`;
            params.push(afterId);
        }

        sql += ` ORDER BY sv.symbol_version_id LIMIT $${params.length + 1}`;
        params.push(pageSize + 1); // fetch one extra to detect next page

        const queryResult = await db.query(sql, params);
        const hasMore = queryResult.rows.length > pageSize;
        const rawRows = hasMore ? queryResult.rows.slice(0, pageSize) : queryResult.rows;
        const rows = validateRows(rawRows, validateSymbolVersionRow, 'batchLoader.loadSymbolVersionsPaginated');
        const lastRow = rows[rows.length - 1];
        const nextCursor = hasMore && lastRow ? lastRow.symbol_version_id : null;

        log.debug('Paginated load symbol versions for snapshot', {
            snapshotId,
            pageSize,
            returned: rows.length,
            hasMore,
        });

        return { rows, nextCursor };
    }
}
