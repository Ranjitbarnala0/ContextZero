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

// ────────── Helpers ──────────

/**
 * Extract potential symbol/identifier names from a natural language description.
 *
 * Recognises:
 *  - camelCase / PascalCase tokens  (e.g. "verifyStep", "allowedFiles")
 *  - snake_case tokens               (e.g. "allowed_files")
 *  - dot-qualified paths              (e.g. "module.verifyStep")
 *  - any word >=3 chars that is NOT a common English stop-word
 *
 * Returns deduplicated candidates ordered longest-first (longer names are
 * more specific and yield better trigram matches).
 */
function extractIdentifierCandidates(text: string): string[] {
    const candidates: Set<string> = new Set();

    // 1. Grab camelCase / PascalCase identifiers — including patterns like
    //    URLHandler, IOError, XMLParser that start with consecutive uppercase.
    const camelRe = /[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g;
    let m: RegExpExecArray | null;
    while ((m = camelRe.exec(text)) !== null) {
        const w = m[0];
        // Accept if it has a case transition (camelCase/PascalCase) or underscore
        if (/[a-z][A-Z]/.test(w) || /[A-Z][a-z]/.test(w) || w.includes('_')) {
            candidates.add(w);
        }
    }

    // 2. Grab PascalCase-only identifiers (start with uppercase, >=3 chars).
    //    Includes patterns like URLHandler, IOError, XMLParser.
    const pascalRe = /\b[A-Z][a-zA-Z0-9]{2,}\b/g;
    while ((m = pascalRe.exec(text)) !== null) {
        const w = m[0];
        // Must have at least one lowercase letter (not ALL_CAPS which is step 3)
        if (/[a-z]/.test(w)) {
            candidates.add(w);
        }
    }

    // 3. Grab snake_case identifiers (word_word).
    const snakeRe = /\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b/g;
    while ((m = snakeRe.exec(text)) !== null) {
        candidates.add(m[0]);
    }

    // 4. Grab dot-qualified names (e.g. "foo.barBaz").
    const dotRe = /\b[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)+\b/g;
    while ((m = dotRe.exec(text)) !== null) {
        candidates.add(m[0]);
        // Also add each segment individually.
        for (const seg of m[0].split('.')) {
            if (seg.length >= 3) candidates.add(seg);
        }
    }

    // 5. Fallback: individual words that look like they could be identifiers
    //    (not common English stop-words, length >= 3).
    const STOP_WORDS = new Set([
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'but',
        'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does',
        'did', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
        'can', 'could', 'its', 'than', 'then', 'when', 'where', 'which',
        'who', 'how', 'any', 'all', 'each', 'every', 'both', 'few', 'more',
        'most', 'other', 'some', 'such', 'only', 'same', 'into', 'also',
        'just', 'about', 'over', 'after', 'before', 'between', 'under',
        'again', 'further', 'once', 'here', 'there', 'why', 'what',
        'fix', 'add', 'use', 'set', 'get', 'put', 'run', 'let', 'try',
        'make', 'call', 'find', 'give', 'take', 'come', 'see', 'look',
        'like', 'want', 'need', 'know', 'think',
    ]);
    const wordRe = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;
    while ((m = wordRe.exec(text)) !== null) {
        const w = m[0];
        if (w.length >= 3 && !STOP_WORDS.has(w.toLowerCase())) {
            candidates.add(w);
        }
    }

    // Deduplicate and sort longest-first (longer = more specific).
    return [...candidates].sort((a, b) => b.length - a.length);
}

/**
 * Build and execute a single symbol resolution query for a given search term.
 */
async function resolveSymbolSingle(
    searchTerm: string,
    repoId: string,
    snapshotId: string | undefined,
    kindFilter: string | undefined,
    limit: number,
): Promise<ResolvedSymbol[]> {
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
    const params: unknown[] = [searchTerm, repoId];
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

    const result = await db.query(sql, params);
    return result.rows as ResolvedSymbol[];
}

// ────────── Service Functions ──────────

/** Heuristic: query is "natural language" if it contains a space and is longer than a typical symbol name. */
function looksLikeNaturalLanguage(query: string): boolean {
    return query.includes(' ') && query.length > 40;
}

/**
 * Resolve symbols by fuzzy name matching (pg_trgm similarity).
 * Transport-agnostic: no Express req/res, no MCP result types.
 *
 * When the query is a natural language sentence (e.g. a task description),
 * identifier-like tokens are extracted and each is searched individually.
 * Results are merged and deduplicated by symbol_version_id, keeping the
 * highest similarity score per symbol.
 */
export async function resolveSymbol(
    query: string,
    repoId: string,
    snapshotId?: string,
    kindFilter?: string,
    limit: number = 10,
): Promise<ResolveSymbolResult> {
    // Cache resolve queries by their full parameter set
    const queryCacheKey = `resolve:${query}:${repoId}:${snapshotId ?? ''}:${kindFilter ?? ''}:${limit}`;
    const cached = queryCache.get(queryCacheKey) as ResolveSymbolResult | undefined;
    if (cached) return cached;

    let symbols: ResolvedSymbol[];

    if (looksLikeNaturalLanguage(query)) {
        // Extract identifier candidates from the natural language description
        const candidates = extractIdentifierCandidates(query);

        if (candidates.length === 0) {
            // Extremely unlikely, but fall through to the original whole-query search
            symbols = await resolveSymbolSingle(query, repoId, snapshotId, kindFilter, limit);
        } else {
            // Search for each candidate in parallel, collect all matches.
            // Use allSettled so one failed candidate doesn't kill the others.
            const settled = await Promise.allSettled(
                candidates.slice(0, 10).map(c =>
                    resolveSymbolSingle(c, repoId, snapshotId, kindFilter, limit),
                ),
            );

            // Merge: deduplicate by symbol_version_id, keep highest name_sim
            const best = new Map<string, ResolvedSymbol>();
            for (const result of settled) {
                if (result.status !== "fulfilled") continue;
                for (const sym of result.value) {
                    const existing = best.get(sym.symbol_version_id);
                    if (!existing || sym.name_sim > existing.name_sim) {
                        best.set(sym.symbol_version_id, sym);
                    }
                }
            }

            // Sort by similarity descending, take top `limit`
            symbols = [...best.values()]
                .sort((a, b) => b.name_sim - a.name_sim)
                .slice(0, limit);
        }
    } else {
        // Short / single-identifier query — use the original direct search
        symbols = await resolveSymbolSingle(query, repoId, snapshotId, kindFilter, limit);
    }

    const resolved: ResolveSymbolResult = { symbols, count: symbols.length };
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
