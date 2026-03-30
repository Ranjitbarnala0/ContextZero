/**
 * ContextZero — Symbol Service
 *
 * Shared business logic for symbol resolution and detail retrieval.
 * Used by both the REST API (mcp-interface) and MCP bridge (mcp-bridge/handlers).
 */

import { db } from '../db-driver';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { symbolCache, queryCache } from '../cache';
import { UserFacingError } from '../types';

// ────────── Result Types ──────────

export interface ResolvedSymbol {
    symbol_id: string;
    canonical_name: string;
    kind: string;
    stable_key: string;
    symbol_version_id: string;
    signature: string;
    visibility: string;
    file_path: string;
    name_sim: number;
}

export interface ResolveSymbolResult {
    symbols: ResolvedSymbol[];
    count: number;
}

export interface SymbolDetailsResult {
    symbol: Record<string, unknown>;
    behavioral_profile?: unknown;
    contract_profile?: unknown;
}

// ────────── Service Functions ──────────

/**
 * Resolve symbols by fuzzy name matching (pg_trgm similarity).
 * Transport-agnostic: no Express req/res, no MCP result types.
 */
export async function resolveSymbol(
    query: string,
    repoId: string,
    snapshotId?: string,
    kindFilter?: string,
    limit: number = 10,
): Promise<ResolveSymbolResult> {
    let sql = `
        SELECT s.symbol_id, s.canonical_name, s.kind, s.stable_key,
               sv.symbol_version_id, sv.signature, sv.visibility,
               f.path as file_path,
               similarity(s.canonical_name, $1) as name_sim
        FROM symbols s
        JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE s.repo_id = $2
    `;
    const params: unknown[] = [query, repoId];
    let paramIdx = 3;

    if (snapshotId) {
        sql += ` AND sv.snapshot_id = $${paramIdx}`;
        params.push(snapshotId);
        paramIdx++;
    }

    if (kindFilter) {
        sql += ` AND s.kind = $${paramIdx}`;
        params.push(kindFilter);
        paramIdx++;
    }

    sql += ` AND (s.canonical_name % $1 OR s.canonical_name ILIKE '%' || $1 || '%')`;
    sql += ` ORDER BY name_sim DESC LIMIT $${paramIdx}`;
    params.push(limit);

    // Cache resolve queries by their full parameter set
    const queryCacheKey = `resolve:${query}:${repoId}:${snapshotId ?? ''}:${kindFilter ?? ''}:${limit}`;
    const cached = queryCache.get(queryCacheKey) as ResolveSymbolResult | undefined;
    if (cached) return cached;

    const result = await db.query(sql, params);
    const resolved = { symbols: result.rows as ResolvedSymbol[], count: result.rowCount ?? 0 };
    queryCache.set(queryCacheKey, resolved);
    return resolved;
}

/**
 * Get detailed symbol information, optionally including behavioral and contract profiles.
 */
export async function getSymbolDetails(
    symbolVersionId: string,
    viewMode: 'code' | 'summary' | 'signature' = 'summary',
): Promise<SymbolDetailsResult> {
    // Check symbolCache first
    const cacheKey = `sv:${symbolVersionId}`;
    let sv = symbolCache.get(cacheKey) as Record<string, unknown> | undefined;

    if (!sv) {
        const svResult = await db.query(`
            SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id,
                   f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id = $1
        `, [symbolVersionId]);

        if (svResult.rows.length === 0) {
            throw UserFacingError.notFound('Symbol version');
        }

        sv = svResult.rows[0] as Record<string, unknown>;
        symbolCache.set(cacheKey, sv);
    }
    const response: SymbolDetailsResult = { symbol: sv };

    if (viewMode === 'signature') {
        response.symbol = {
            symbol_version_id: sv.symbol_version_id,
            canonical_name: sv.canonical_name,
            kind: sv.kind,
            signature: sv.signature,
            file_path: sv.file_path,
        };
    } else if (viewMode === 'code' || viewMode === 'summary') {
        const [bp, cp] = await Promise.all([
            behavioralEngine.getProfile(symbolVersionId),
            contractEngine.getProfile(symbolVersionId),
        ]);
        if (bp) response.behavioral_profile = bp;
        if (cp) response.contract_profile = cp;
    }

    return response;
}
