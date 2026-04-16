/**
 * ContextZero — Symbol Lineage Engine
 *
 * Gives every symbol a persistent identity that survives re-indexing, renames,
 * and file moves. Solves the critical problem that symbol UUIDs die on restart.
 *
 * Identity is built from a deterministic SHA-256 seed of:
 *   (repo, language, kind, ancestry, name, signature hash, file path context)
 *
 * Lineage matching across re-index uses a layered strategy:
 *   Layer 1: Exact identity seed match (unchanged symbols)
 *   Layer 2: Fuzzy matching for renamed/moved symbols via:
 *            - Normalized AST similarity
 *            - Body hash similarity
 *            - Neighborhood graph similarity (callers/callees)
 *            - Signature compatibility
 *            - Name edit distance
 *
 * Lifecycle tracking: birth, death, rename with confidence scoring.
 */

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { firstRow, optionalStringField, parseCountField } from '../db-driver/result';
import { Logger } from '../logger';
const log = new Logger('symbol-lineage');

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface LineageEntry {
    lineage_id: string;
    repo_id: string;
    identity_seed: string;
    canonical_name: string;
    kind: string;
    language: string;
    birth_snapshot_id: string | null;
    death_snapshot_id: string | null;
    previous_lineage_id: string | null;
    rename_confidence: number | null;
    is_alive: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface RenameMatch {
    old_lineage_id: string;
    old_canonical_name: string;
    new_symbol_id: string;
    new_canonical_name: string;
    new_identity_seed: string;
    confidence: number;
    match_signals: MatchSignals;
}

export interface MatchSignals {
    normalized_ast_similarity: number;
    body_hash_similarity: number;
    neighborhood_similarity: number;
    signature_similarity: number;
    name_edit_distance: number;
    /** Weighted aggregate of all signals */
    weighted_score: number;
}

export interface LineageResult {
    repo_id: string;
    snapshot_id: string;
    total_symbols: number;
    exact_matches: number;
    renames_detected: number;
    births: number;
    deaths: number;
    duration_ms: number;
}

/** Row shape returned when loading snapshot symbols for lineage computation */
interface SnapshotSymbolRow {
    symbol_id: string;
    symbol_version_id: string;
    canonical_name: string;
    kind: string;
    language: string;
    stable_key: string;
    signature: string;
    ast_hash: string;
    body_hash: string;
    normalized_ast_hash: string | null;
    file_path: string;
    logical_namespace: string | null;
}

/** Lightweight neighbor set for neighborhood graph similarity */
interface NeighborhoodSet {
    callers: Set<string>;
    callees: Set<string>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tuning constants
// ──────────────────────────────────────────────────────────────────────────────

/** Minimum confidence to accept a rename match */
const RENAME_CONFIDENCE_THRESHOLD = 0.45;

/** Maximum number of old candidates to run expensive matching against per new symbol */
const MAX_FUZZY_CANDIDATES = 200;

/** Weights for fuzzy matching signals */
const MATCH_WEIGHTS = {
    normalized_ast: 0.30,
    body_hash: 0.25,
    neighborhood: 0.15,
    signature: 0.15,
    name_distance: 0.15,
} as const;

/** Batch size for DB operations to stay within PostgreSQL parameter limits */
const BATCH_SIZE = 500;

// ──────────────────────────────────────────────────────────────────────────────
// Engine
// ──────────────────────────────────────────────────────────────────────────────

export class SymbolLineageEngine {

    // ──────────────────────────────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Compute lineage for all symbols in a snapshot.
     *
     * For the first snapshot (previousSnapshotId === null), every symbol is
     * a birth. For subsequent snapshots, the engine:
     *   1. Computes identity seeds for all new symbols
     *   2. Matches against existing alive lineages (exact seed match)
     *   3. Runs fuzzy matching for unmatched symbols (rename/move detection)
     *   4. Creates birth records for truly new symbols
     *   5. Marks death records for lineages not present in the new snapshot
     *   6. Links symbols to their lineage_id in the symbols table
     */
    public async computeLineage(
        repoId: string,
        snapshotId: string,
        previousSnapshotId: string | null
    ): Promise<LineageResult> {
        const timer = log.startTimer('computeLineage', {
            repoId, snapshotId, previousSnapshotId,
        });
        const startTime = Date.now();

        // Load all symbols in the new snapshot
        const newSymbols = await this.loadSnapshotSymbols(snapshotId);
        log.info('Loaded new snapshot symbols', { snapshotId, count: newSymbols.length });

        if (newSymbols.length === 0) {
            const result: LineageResult = {
                repo_id: repoId,
                snapshot_id: snapshotId,
                total_symbols: 0,
                exact_matches: 0,
                renames_detected: 0,
                births: 0,
                deaths: 0,
                duration_ms: Date.now() - startTime,
            };
            timer({ ...result });
            return result;
        }

        // Compute identity seeds for all new symbols
        const seedMap = new Map<string, { seed: string; symbol: SnapshotSymbolRow }>();
        for (const sym of newSymbols) {
            const ancestry = sym.logical_namespace || this.extractAncestry(sym.stable_key);
            const signatureHash = this.hashSignature(sym.signature);
            const fileContext = this.extractFileContext(sym.file_path);
            const seed = this.computeIdentitySeed(
                repoId, sym.language, sym.kind, ancestry,
                sym.canonical_name, signatureHash, fileContext
            );
            seedMap.set(sym.symbol_id, { seed, symbol: sym });
        }

        // Load existing alive lineages for this repo
        const aliveLineages = await this.getAliveLineages(repoId);
        const lineageBySeed = new Map<string, LineageEntry>();
        for (const lineage of aliveLineages) {
            lineageBySeed.set(lineage.identity_seed, lineage);
        }

        let exactMatches = 0;
        let renamesDetected = 0;
        let births = 0;
        let deaths = 0;

        // Track which lineages are still alive after this snapshot
        const matchedLineageIds = new Set<string>();
        // Track unmatched new symbols for fuzzy matching
        const unmatchedSymbols: Array<{ symbolId: string; seed: string; symbol: SnapshotSymbolRow }> = [];
        // Accumulate all DB mutations for batch execution
        const linkStatements: Array<{ text: string; params: unknown[] }> = [];
        const newLineageStatements: Array<{ text: string; params: unknown[] }> = [];

        // ── Layer 1: Exact identity seed match ──────────────────────────────
        for (const [symbolId, entry] of seedMap) {
            const existingLineage = lineageBySeed.get(entry.seed);
            if (existingLineage) {
                // Exact match — symbol identity preserved
                matchedLineageIds.add(existingLineage.lineage_id);
                linkStatements.push({
                    text: `UPDATE symbols SET lineage_id = $1 WHERE symbol_id = $2`,
                    params: [existingLineage.lineage_id, symbolId],
                });
                // Update lineage metadata if name/kind changed (cosmetic update)
                linkStatements.push({
                    text: `UPDATE symbol_lineage SET canonical_name = $1, updated_at = NOW()
                           WHERE lineage_id = $2`,
                    params: [entry.symbol.canonical_name, existingLineage.lineage_id],
                });
                exactMatches++;
            } else {
                unmatchedSymbols.push({ symbolId, seed: entry.seed, symbol: entry.symbol });
            }
        }

        // ── Layer 2: Fuzzy matching for renamed/moved symbols ───────────────
        if (previousSnapshotId && unmatchedSymbols.length > 0) {
            // Collect lineages that were NOT exact-matched — candidates for rename
            const unmatchedLineages = aliveLineages.filter(
                l => !matchedLineageIds.has(l.lineage_id)
            );

            if (unmatchedLineages.length > 0) {
                const renames = await this.matchRenamedSymbols(
                    repoId, previousSnapshotId, snapshotId,
                    unmatchedLineages, unmatchedSymbols
                );

                // Apply renames
                const renamedSymbolIds = new Set<string>();
                const renamedLineageIds = new Set<string>();

                for (const rename of renames) {
                    // Skip if either side was already consumed by a higher-confidence match
                    if (renamedSymbolIds.has(rename.new_symbol_id)) continue;
                    if (renamedLineageIds.has(rename.old_lineage_id)) continue;

                    renamedSymbolIds.add(rename.new_symbol_id);
                    renamedLineageIds.add(rename.old_lineage_id);
                    matchedLineageIds.add(rename.old_lineage_id);

                    // Mark old lineage as dead (it was renamed)
                    linkStatements.push({
                        text: `UPDATE symbol_lineage SET is_alive = FALSE, death_snapshot_id = $1, updated_at = NOW()
                               WHERE lineage_id = $2`,
                        params: [snapshotId, rename.old_lineage_id],
                    });

                    // Create new lineage linked to old via previous_lineage_id
                    const newLineageId = uuidv4();
                    newLineageStatements.push({
                        text: `INSERT INTO symbol_lineage (
                                   lineage_id, repo_id, identity_seed, canonical_name, kind, language,
                                   birth_snapshot_id, previous_lineage_id, rename_confidence, is_alive
                               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
                               ON CONFLICT (repo_id, identity_seed) DO UPDATE SET
                                   canonical_name = EXCLUDED.canonical_name,
                                   previous_lineage_id = EXCLUDED.previous_lineage_id,
                                   rename_confidence = EXCLUDED.rename_confidence,
                                   is_alive = TRUE,
                                   death_snapshot_id = NULL,
                                   updated_at = NOW()`,
                        params: (() => {
                            const matched = unmatchedSymbols.find(s => s.symbolId === rename.new_symbol_id);
                            if (!matched) {
                                log.warn('Rename target symbol not found in unmatched list, using fallback', {
                                    symbolId: rename.new_symbol_id,
                                    snapshotId,
                                });
                            }
                            return [
                                newLineageId, repoId, rename.new_identity_seed,
                                rename.new_canonical_name,
                                matched?.symbol.kind ?? 'unknown',
                                matched?.symbol.language ?? 'unknown',
                                snapshotId, rename.old_lineage_id, rename.confidence,
                            ];
                        })(),
                    });

                    // Link symbol to new lineage.
                    // NOTE: we look up the lineage_id by (repo_id, identity_seed) rather
                    // than trusting newLineageId — the INSERT above uses ON CONFLICT DO UPDATE,
                    // which keeps the PRE-EXISTING lineage_id when a row for this seed is
                    // already present (left over from a prior ingestion of the same repo).
                    linkStatements.push({
                        text: `UPDATE symbols SET lineage_id = (
                                   SELECT lineage_id FROM symbol_lineage
                                   WHERE repo_id = $1 AND identity_seed = $2
                               ) WHERE symbol_id = $3`,
                        params: [repoId, rename.new_identity_seed, rename.new_symbol_id],
                    });

                    renamesDetected++;
                }

                // Remove consumed symbols from unmatched list
                const stillUnmatched = unmatchedSymbols.filter(
                    s => !renamedSymbolIds.has(s.symbolId)
                );
                unmatchedSymbols.length = 0;
                unmatchedSymbols.push(...stillUnmatched);
            }
        }

        // ── Births: truly new symbols ───────────────────────────────────────
        for (const { symbolId, seed, symbol } of unmatchedSymbols) {
            const lineageId = uuidv4();
            newLineageStatements.push({
                text: `INSERT INTO symbol_lineage (
                           lineage_id, repo_id, identity_seed, canonical_name, kind, language,
                           birth_snapshot_id, is_alive
                       ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
                       ON CONFLICT (repo_id, identity_seed) DO UPDATE SET
                           canonical_name = EXCLUDED.canonical_name,
                           is_alive = TRUE,
                           death_snapshot_id = NULL,
                           updated_at = NOW()`,
                params: [
                    lineageId, repoId, seed, symbol.canonical_name,
                    symbol.kind, symbol.language, snapshotId,
                ],
            });

            // Look up lineage_id by identity_seed — see note in the rename block above.
            // ON CONFLICT DO UPDATE keeps the pre-existing lineage_id if one was already
            // present for this (repo_id, identity_seed) pair.
            linkStatements.push({
                text: `UPDATE symbols SET lineage_id = (
                           SELECT lineage_id FROM symbol_lineage
                           WHERE repo_id = $1 AND identity_seed = $2
                       ) WHERE symbol_id = $3`,
                params: [repoId, seed, symbolId],
            });

            births++;
        }

        // ── Deaths: lineages not present in the new snapshot ────────────────
        const deathStatements: Array<{ text: string; params: unknown[] }> = [];
        if (previousSnapshotId) {
            for (const lineage of aliveLineages) {
                if (!matchedLineageIds.has(lineage.lineage_id)) {
                    deathStatements.push({
                        text: `UPDATE symbol_lineage SET is_alive = FALSE, death_snapshot_id = $1, updated_at = NOW()
                               WHERE lineage_id = $2 AND is_alive = TRUE`,
                        params: [snapshotId, lineage.lineage_id],
                    });
                    deaths++;
                }
            }
        }

        // ── Persist everything in batched transactions ──────────────────────
        const allStatements = [
            ...newLineageStatements,
            ...linkStatements,
            ...deathStatements,
        ];

        if (allStatements.length > 0) {
            // Execute in chunks to avoid overwhelming the connection
            for (let i = 0; i < allStatements.length; i += BATCH_SIZE) {
                const chunk = allStatements.slice(i, i + BATCH_SIZE);
                await db.batchInsert(chunk);
            }
        }

        const result: LineageResult = {
            repo_id: repoId,
            snapshot_id: snapshotId,
            total_symbols: newSymbols.length,
            exact_matches: exactMatches,
            renames_detected: renamesDetected,
            births,
            deaths,
            duration_ms: Date.now() - startTime,
        };

        log.info('Lineage computation complete', { ...result });
        timer({ ...result });
        return result;
    }

    /**
     * Compute a deterministic identity seed for a symbol.
     *
     * The seed is a SHA-256 hash of the concatenated factors. Identical input
     * always produces the same seed, so re-indexing an unchanged symbol
     * yields the same identity.
     *
     * Factors:
     *   - repoId:       scopes lineage to a single repository
     *   - language:      prevents cross-language collisions (Python `validate` vs TS `validate`)
     *   - kind:          prevents cross-kind collisions (class `User` vs function `User`)
     *   - ancestry:      parent class/module (e.g., "UserService" for `UserService.validate`)
     *   - name:          canonical symbol name
     *   - signatureHash: normalized parameter/return type fingerprint
     *   - filePath:      relative file path context (directory component only)
     */
    public computeIdentitySeed(
        repoId: string,
        language: string,
        kind: string,
        ancestry: string,
        name: string,
        signatureHash: string,
        filePath: string
    ): string {
        const payload = [
            repoId,
            language.toLowerCase(),
            kind.toLowerCase(),
            ancestry.toLowerCase(),
            name,
            signatureHash,
            filePath.toLowerCase(),
        ].join('\x00'); // Null byte separator prevents collisions from concatenation ambiguity

        return crypto.createHash('sha256').update(payload).digest('hex');
    }

    /**
     * Match symbols between snapshots for rename detection.
     *
     * Uses a multi-signal approach:
     *   1. Normalized AST similarity (same structure, different name)
     *   2. Body hash similarity (same content, different location)
     *   3. Neighborhood graph similarity (same callers/callees)
     *   4. Signature compatibility
     *   5. Name edit distance (low distance = likely rename)
     *
     * Returns matches sorted by descending confidence. The caller is
     * responsible for greedy 1:1 assignment (each old lineage maps to
     * at most one new symbol and vice versa).
     */
    public async matchRenamedSymbols(
        repoId: string,
        oldSnapshotId: string,
        newSnapshotId: string,
        unmatchedLineages?: LineageEntry[],
        unmatchedNewSymbols?: Array<{ symbolId: string; seed: string; symbol: SnapshotSymbolRow }>
    ): Promise<RenameMatch[]> {
        const timer = log.startTimer('matchRenamedSymbols', {
            repoId, oldSnapshotId, newSnapshotId,
        });

        // Load old snapshot symbols
        const oldSymbols = await this.loadSnapshotSymbols(oldSnapshotId);
        const newSymbols = unmatchedNewSymbols
            ? unmatchedNewSymbols.map(s => s.symbol)
            : await this.loadSnapshotSymbols(newSnapshotId);

        if (oldSymbols.length === 0 || newSymbols.length === 0) {
            timer({ matches: 0 });
            return [];
        }

        // Build neighborhood maps for both snapshots
        const [oldNeighborhoods, newNeighborhoods] = await Promise.all([
            this.buildNeighborhoodMap(oldSnapshotId),
            this.buildNeighborhoodMap(newSnapshotId),
        ]);

        // If we have specific unmatched lineages, only consider old symbols that
        // belong to those lineages. Otherwise, consider all old symbols.
        const unmatchedLineageNames = unmatchedLineages
            ? new Set(unmatchedLineages.map(l => l.canonical_name))
            : null;

        const oldCandidates = unmatchedLineageNames
            ? oldSymbols.filter(s => unmatchedLineageNames.has(s.canonical_name))
            : oldSymbols;

        // Index old symbols by kind for efficient filtering
        const oldByKind = new Map<string, SnapshotSymbolRow[]>();
        for (const old of oldCandidates) {
            const existing = oldByKind.get(old.kind) || [];
            existing.push(old);
            oldByKind.set(old.kind, existing);
        }

        // Build lineage lookup: canonical_name -> lineage
        const lineageByName = new Map<string, LineageEntry>();
        if (unmatchedLineages) {
            for (const l of unmatchedLineages) {
                lineageByName.set(l.canonical_name, l);
            }
        }

        // Batch-load all lineage_ids for old candidates when not using unmatchedLineages
        // so we avoid per-candidate DB queries inside the loop.
        const lineageIdBySymbolId = new Map<string, string>();
        if (!unmatchedLineages) {
            const allOldSymbolIds = oldCandidates.map(s => s.symbol_id);
            if (allOldSymbolIds.length > 0) {
                const placeholders = allOldSymbolIds.map((_, i) => `$${i + 1}`).join(',');
                const lineageBatch = await db.query(
                    `SELECT symbol_id, lineage_id FROM symbols WHERE symbol_id IN (${placeholders})`,
                    allOldSymbolIds
                );
                for (const row of lineageBatch.rows as { symbol_id: string; lineage_id: string | null }[]) {
                    if (row.lineage_id) {
                        lineageIdBySymbolId.set(row.symbol_id, row.lineage_id);
                    }
                }
            }
        }

        const matches: RenameMatch[] = [];

        for (const newSym of newSymbols) {
            // Only match against same-kind symbols (function <-> function, class <-> class)
            const sameKindOld = oldByKind.get(newSym.kind);
            if (!sameKindOld || sameKindOld.length === 0) continue;

            // Pre-filter to same language and exclude self-matches
            const eligible = sameKindOld.filter(oldSym =>
                oldSym.language === newSym.language &&
                !(oldSym.canonical_name === newSym.canonical_name &&
                  oldSym.file_path === newSym.file_path)
            );
            if (eligible.length === 0) continue;

            // Pre-sort candidates by name edit distance (cheapest signal) and cap
            const scored = eligible.map(oldSym => ({
                sym: oldSym,
                nameDist: this.levenshteinDistance(oldSym.canonical_name, newSym.canonical_name),
            }));
            scored.sort((a, b) => a.nameDist - b.nameDist);
            const candidates = scored.slice(0, MAX_FUZZY_CANDIDATES);

            let bestMatch: RenameMatch | null = null;
            let bestScore = 0;

            for (const { sym: oldSym } of candidates) {
                const signals = this.computeMatchSignals(
                    oldSym, newSym,
                    oldNeighborhoods.get(oldSym.symbol_version_id) || { callers: new Set(), callees: new Set() },
                    newNeighborhoods.get(newSym.symbol_version_id) || { callers: new Set(), callees: new Set() }
                );

                if (signals.weighted_score > bestScore && signals.weighted_score >= RENAME_CONFIDENCE_THRESHOLD) {
                    bestScore = signals.weighted_score;

                    // Resolve lineage_id for the old symbol
                    let oldLineageId: string | undefined;
                    if (unmatchedLineages) {
                        const lineage = lineageByName.get(oldSym.canonical_name);
                        if (!lineage) continue;
                        oldLineageId = lineage.lineage_id;
                    } else {
                        oldLineageId = lineageIdBySymbolId.get(oldSym.symbol_id);
                        if (!oldLineageId) continue;
                    }

                    // Compute new identity seed
                    const ancestry = newSym.logical_namespace || this.extractAncestry(newSym.stable_key);
                    const sigHash = this.hashSignature(newSym.signature);
                    const fileCtx = this.extractFileContext(newSym.file_path);
                    const newSeed = this.computeIdentitySeed(
                        repoId, newSym.language, newSym.kind, ancestry,
                        newSym.canonical_name, sigHash, fileCtx
                    );

                    bestMatch = {
                        old_lineage_id: oldLineageId,
                        old_canonical_name: oldSym.canonical_name,
                        new_symbol_id: newSym.symbol_id,
                        new_canonical_name: newSym.canonical_name,
                        new_identity_seed: newSeed,
                        confidence: signals.weighted_score,
                        match_signals: signals,
                    };
                }
            }

            if (bestMatch) {
                matches.push(bestMatch);
            }
        }

        // Sort by confidence descending for greedy 1:1 assignment
        matches.sort((a, b) => b.confidence - a.confidence);

        timer({ matches: matches.length });
        return matches;
    }

    /**
     * Get lineage history for a symbol.
     *
     * Walks the previous_lineage_id chain backwards to reconstruct the full
     * rename/move history of a symbol's identity.
     */
    public async getLineageHistory(symbolId: string): Promise<LineageEntry[]> {
        // Get the current lineage_id for this symbol
        const symbolResult = await db.query(
            `SELECT lineage_id FROM symbols WHERE symbol_id = $1`,
            [symbolId]
        );
        const currentLineageId = optionalStringField(firstRow(symbolResult), 'lineage_id');
        if (!currentLineageId) return [];

        // Walk the chain backwards via recursive CTE
        const result = await db.query(`
            WITH RECURSIVE lineage_chain AS (
                SELECT sl.*, 0 AS depth
                FROM symbol_lineage sl
                WHERE sl.lineage_id = $1

                UNION ALL

                SELECT sl.*, lc.depth + 1
                FROM symbol_lineage sl
                JOIN lineage_chain lc ON sl.lineage_id = lc.previous_lineage_id
                WHERE lc.depth < 100  -- safety limit to prevent infinite loops
            )
            SELECT * FROM lineage_chain
            ORDER BY depth ASC
        `, [currentLineageId]);

        return result.rows as LineageEntry[];
    }

    /**
     * Get all alive lineages for a repository.
     */
    public async getAliveLineages(repoId: string): Promise<LineageEntry[]> {
        const result = await db.query(`
            SELECT * FROM symbol_lineage
            WHERE repo_id = $1 AND is_alive = TRUE
            ORDER BY canonical_name
        `, [repoId]);

        return result.rows as LineageEntry[];
    }

    /**
     * Get a single lineage entry by ID.
     */
    public async getLineageById(lineageId: string): Promise<LineageEntry | null> {
        const result = await db.query(
            `SELECT * FROM symbol_lineage WHERE lineage_id = $1`,
            [lineageId]
        );
        return (result.rows[0] as LineageEntry | undefined) ?? null;
    }

    /**
     * Get the lineage entry for a specific symbol.
     */
    public async getLineageForSymbol(symbolId: string): Promise<LineageEntry | null> {
        const result = await db.query(`
            SELECT sl.*
            FROM symbol_lineage sl
            JOIN symbols s ON s.lineage_id = sl.lineage_id
            WHERE s.symbol_id = $1
        `, [symbolId]);
        return (result.rows[0] as LineageEntry | undefined) ?? null;
    }

    /**
     * Get lineage statistics for a repository.
     */
    public async getLineageStats(repoId: string): Promise<{
        total_lineages: number;
        alive_lineages: number;
        dead_lineages: number;
        renamed_lineages: number;
        lineages_by_kind: Record<string, number>;
        lineages_by_language: Record<string, number>;
    }> {
        const [totalResult, aliveResult, renamedResult, byKindResult, byLangResult] = await Promise.all([
            db.query(`SELECT COUNT(*) as cnt FROM symbol_lineage WHERE repo_id = $1`, [repoId]),
            db.query(`SELECT COUNT(*) as cnt FROM symbol_lineage WHERE repo_id = $1 AND is_alive = TRUE`, [repoId]),
            db.query(`SELECT COUNT(*) as cnt FROM symbol_lineage WHERE repo_id = $1 AND previous_lineage_id IS NOT NULL`, [repoId]),
            db.query(`SELECT kind, COUNT(*) as cnt FROM symbol_lineage WHERE repo_id = $1 GROUP BY kind`, [repoId]),
            db.query(`SELECT language, COUNT(*) as cnt FROM symbol_lineage WHERE repo_id = $1 GROUP BY language`, [repoId]),
        ]);

        const total = parseCountField(firstRow(totalResult));
        const alive = parseCountField(firstRow(aliveResult));
        const renamed = parseCountField(firstRow(renamedResult));

        const byKind: Record<string, number> = {};
        for (const row of byKindResult.rows as { kind: string; cnt: string }[]) {
            byKind[row.kind] = parseInt(row.cnt, 10);
        }

        const byLang: Record<string, number> = {};
        for (const row of byLangResult.rows as { language: string; cnt: string }[]) {
            byLang[row.language] = parseInt(row.cnt, 10);
        }

        return {
            total_lineages: total,
            alive_lineages: alive,
            dead_lineages: total - alive,
            renamed_lineages: renamed,
            lineages_by_kind: byKind,
            lineages_by_language: byLang,
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal: Data Loading
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Load all symbols in a snapshot with their version data, joined with
     * the symbols table for canonical_name, kind, and stable_key.
     */
    private async loadSnapshotSymbols(snapshotId: string): Promise<SnapshotSymbolRow[]> {
        const result = await db.query(`
            SELECT
                s.symbol_id,
                sv.symbol_version_id,
                s.canonical_name,
                s.kind,
                sv.language,
                s.stable_key,
                sv.signature,
                sv.ast_hash,
                sv.body_hash,
                sv.normalized_ast_hash,
                f.path AS file_path,
                s.logical_namespace
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        return result.rows as SnapshotSymbolRow[];
    }

    /**
     * Build a map of symbol_version_id -> { callers, callees } from
     * structural_relations in a given snapshot. Used for neighborhood
     * graph similarity during fuzzy matching.
     */
    private async buildNeighborhoodMap(
        snapshotId: string
    ): Promise<Map<string, NeighborhoodSet>> {
        const map = new Map<string, NeighborhoodSet>();

        const ensure = (svId: string): NeighborhoodSet => {
            let ns = map.get(svId);
            if (!ns) {
                ns = { callers: new Set(), callees: new Set() };
                map.set(svId, ns);
            }
            return ns;
        };

        // Load all call/reference edges for this snapshot
        const result = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id,
                   s_src.canonical_name AS src_name, s_dst.canonical_name AS dst_name
            FROM structural_relations sr
            JOIN symbol_versions sv_src ON sv_src.symbol_version_id = sr.src_symbol_version_id
            JOIN symbols s_src ON s_src.symbol_id = sv_src.symbol_id
            JOIN symbol_versions sv_dst ON sv_dst.symbol_version_id = sr.dst_symbol_version_id
            JOIN symbols s_dst ON s_dst.symbol_id = sv_dst.symbol_id
            WHERE sv_src.snapshot_id = $1
            AND sr.relation_type IN ('calls', 'references', 'imports')
        `, [snapshotId]);

        for (const row of result.rows as {
            src_symbol_version_id: string;
            dst_symbol_version_id: string;
            src_name: string;
            dst_name: string;
        }[]) {
            // Use canonical names as the identity for neighborhood comparison
            // (since symbol_version_ids differ across snapshots)
            ensure(row.src_symbol_version_id).callees.add(row.dst_name);
            ensure(row.dst_symbol_version_id).callers.add(row.src_name);
        }

        return map;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal: Matching Signals
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Compute all matching signals between an old symbol and a new symbol.
     */
    private computeMatchSignals(
        oldSym: SnapshotSymbolRow,
        newSym: SnapshotSymbolRow,
        oldNeighbors: NeighborhoodSet,
        newNeighbors: NeighborhoodSet
    ): MatchSignals {
        // Signal 1: Normalized AST similarity
        const normalizedAstSim = this.computeNormalizedAstSimilarity(oldSym, newSym);

        // Signal 2: Body hash similarity
        const bodyHashSim = this.computeBodyHashSimilarity(oldSym, newSym);

        // Signal 3: Neighborhood graph similarity
        const neighborhoodSim = this.computeNeighborhoodSimilarity(oldNeighbors, newNeighbors);

        // Signal 4: Signature compatibility
        const signatureSim = this.computeSignatureSimilarity(oldSym.signature, newSym.signature);

        // Signal 5: Name edit distance (normalized to 0-1 similarity)
        const nameDistance = this.computeNameEditDistance(oldSym.canonical_name, newSym.canonical_name);

        // Weighted score
        const weightedScore =
            MATCH_WEIGHTS.normalized_ast * normalizedAstSim +
            MATCH_WEIGHTS.body_hash * bodyHashSim +
            MATCH_WEIGHTS.neighborhood * neighborhoodSim +
            MATCH_WEIGHTS.signature * signatureSim +
            MATCH_WEIGHTS.name_distance * nameDistance;

        return {
            normalized_ast_similarity: normalizedAstSim,
            body_hash_similarity: bodyHashSim,
            neighborhood_similarity: neighborhoodSim,
            signature_similarity: signatureSim,
            name_edit_distance: nameDistance,
            weighted_score: Math.min(1.0, weightedScore),
        };
    }

    /**
     * Normalized AST similarity.
     *
     * Levels:
     *   - Identical normalized_ast_hash: 1.0 (rename-invariant structural match)
     *   - Identical ast_hash: 0.85 (whitespace-only change)
     *   - Different: 0.0
     */
    private computeNormalizedAstSimilarity(
        oldSym: SnapshotSymbolRow,
        newSym: SnapshotSymbolRow
    ): number {
        if (oldSym.normalized_ast_hash && newSym.normalized_ast_hash &&
            oldSym.normalized_ast_hash === newSym.normalized_ast_hash) {
            return 1.0;
        }
        if (oldSym.ast_hash === newSym.ast_hash) {
            return 0.85;
        }
        return 0.0;
    }

    /**
     * Body hash similarity.
     *
     * If the body_hash matches, the function body is byte-identical.
     * This is the strongest signal that two symbols are the same function,
     * even if renamed or moved to a different file.
     */
    private computeBodyHashSimilarity(
        oldSym: SnapshotSymbolRow,
        newSym: SnapshotSymbolRow
    ): number {
        if (oldSym.body_hash === newSym.body_hash) {
            return 1.0;
        }
        // Partial credit if AST matches (similar but not identical body)
        if (oldSym.ast_hash === newSym.ast_hash) {
            return 0.70;
        }
        if (oldSym.normalized_ast_hash && newSym.normalized_ast_hash &&
            oldSym.normalized_ast_hash === newSym.normalized_ast_hash) {
            return 0.60;
        }
        return 0.0;
    }

    /**
     * Neighborhood graph similarity (Jaccard on caller/callee canonical names).
     *
     * If a function calls the same set of functions and is called by the same
     * set of callers, it is very likely the same function, even if renamed.
     */
    private computeNeighborhoodSimilarity(
        oldNeighbors: NeighborhoodSet,
        newNeighbors: NeighborhoodSet
    ): number {
        const callerJaccard = this.jaccardSimilarity(oldNeighbors.callers, newNeighbors.callers);
        const calleeJaccard = this.jaccardSimilarity(oldNeighbors.callees, newNeighbors.callees);

        // Both empty neighborhoods = no signal (not similar, not dissimilar)
        if (oldNeighbors.callers.size === 0 && newNeighbors.callers.size === 0 &&
            oldNeighbors.callees.size === 0 && newNeighbors.callees.size === 0) {
            return 0.0;
        }

        // Weight callees higher (what you call is more identity-defining than who calls you)
        return callerJaccard * 0.4 + calleeJaccard * 0.6;
    }

    /**
     * Signature similarity.
     *
     * Compares parameter counts, return types, and type token overlap
     * between two function signatures.
     */
    private computeSignatureSimilarity(sigA: string, sigB: string): number {
        if (!sigA || !sigB) return 0.0;
        if (sigA === sigB) return 1.0;

        let score = 0;

        // Compare parameter counts (graduated)
        const paramsA = (sigA.match(/\((.*?)\)/)?.[1] || '').split(',').filter(Boolean);
        const paramsB = (sigB.match(/\((.*?)\)/)?.[1] || '').split(',').filter(Boolean);
        const maxParams = Math.max(paramsA.length, paramsB.length);
        if (maxParams === 0) {
            score += 0.4; // Both zero-arg
        } else {
            const minParams = Math.min(paramsA.length, paramsB.length);
            score += 0.4 * (minParams / maxParams);
        }

        // Compare return types
        const retA = sigA.split(':').pop()?.trim() || '';
        const retB = sigB.split(':').pop()?.trim() || '';
        if (retA && retB && retA === retB) {
            score += 0.3;
        }

        // Type token Jaccard
        const tokensA = new Set(sigA.replace(/[(),:]/g, ' ').toLowerCase().split(/\s+/).filter(t => t.length > 1));
        const tokensB = new Set(sigB.replace(/[(),:]/g, ' ').toLowerCase().split(/\s+/).filter(t => t.length > 1));
        if (tokensA.size > 0 && tokensB.size > 0) {
            let overlap = 0;
            for (const t of tokensA) if (tokensB.has(t)) overlap++;
            const union = new Set([...tokensA, ...tokensB]).size;
            score += 0.3 * (overlap / union);
        }

        return Math.min(1.0, score);
    }

    /**
     * Name edit distance, normalized to a 0-1 similarity score.
     *
     * Uses Levenshtein distance normalized by the length of the longer name.
     * A small edit distance (e.g., `validateUser` -> `validateAccount`) gets
     * a high similarity score.
     */
    private computeNameEditDistance(nameA: string, nameB: string): number {
        if (nameA === nameB) return 1.0;
        if (!nameA || !nameB) return 0.0;

        const distance = this.levenshteinDistance(
            nameA.toLowerCase(),
            nameB.toLowerCase()
        );
        const maxLen = Math.max(nameA.length, nameB.length);
        if (maxLen === 0) return 1.0;

        // Normalize: 0 distance = 1.0 similarity, maxLen distance = 0.0
        const similarity = 1.0 - (distance / maxLen);

        // Also check token-level overlap (camelCase/snake_case split)
        const tokensA = this.tokenizeName(nameA);
        const tokensB = this.tokenizeName(nameB);
        const tokenJaccard = this.jaccardSimilarity(tokensA, tokensB);

        // Take the better of character-level and token-level similarity
        return Math.max(similarity, tokenJaccard);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal: Utility Functions
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Extract ancestry (parent class/module) from a stable_key.
     *
     * stable_key format: "path/file.ts::ClassName.methodName" or "path/file.ts#ClassName"
     * Ancestry is the part between the separator and the final name component.
     */
    private extractAncestry(stableKey: string): string {
        // Find the symbol part after :: or #
        let sepIdx = stableKey.indexOf('::');
        if (sepIdx < 0) sepIdx = stableKey.indexOf('#');
        if (sepIdx < 0) return '';

        const symbolPart = stableKey.substring(sepIdx + (stableKey[sepIdx] === ':' ? 2 : 1));

        // Split by dots to find ancestry
        const parts = symbolPart.split('.');
        if (parts.length <= 1) return ''; // No parent
        // Return everything except the last component
        return parts.slice(0, -1).join('.');
    }

    /**
     * Extract file path context for identity seeding.
     *
     * Uses the directory path (not filename) to avoid churn when a symbol
     * is renamed but stays in the same directory. This provides just enough
     * location context to disambiguate same-named symbols in different modules.
     */
    private extractFileContext(filePath: string): string {
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash <= 0) return '';
        return filePath.substring(0, lastSlash);
    }

    /**
     * Hash a signature string for use in identity seeding.
     *
     * Normalizes whitespace and parameter names to produce a stable hash
     * that only changes when the type structure changes.
     */
    private hashSignature(signature: string): string {
        if (!signature) return 'empty';

        // Normalize: strip parameter names, collapse whitespace
        const normalized = signature
            .replace(/\s+/g, ' ')           // Collapse whitespace
            .replace(/\b\w+\s*:/g, ':')     // Strip parameter names (keep types)
            .replace(/\s*,\s*/g, ',')        // Normalize comma spacing
            .trim();

        return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
    }

    /**
     * Compute Jaccard similarity between two sets.
     */
    private jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
        if (setA.size === 0 && setB.size === 0) return 0.0;
        if (setA.size === 0 || setB.size === 0) return 0.0;

        let intersection = 0;
        const smaller = setA.size <= setB.size ? setA : setB;
        const larger = setA.size <= setB.size ? setB : setA;
        for (const item of smaller) {
            if (larger.has(item)) intersection++;
        }

        const union = setA.size + setB.size - intersection;
        return union > 0 ? intersection / union : 0.0;
    }

    /**
     * Levenshtein edit distance between two strings.
     *
     * Uses Wagner-Fischer dynamic programming algorithm.
     * Space-optimized to O(min(m,n)) using two-row approach.
     */
    private levenshteinDistance(a: string, b: string): number {
        if (a === b) return 0;
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        // Ensure a is the shorter string for space optimization
        if (a.length > b.length) {
            const tmp = a;
            a = b;
            b = tmp;
        }

        const aLen = a.length;
        const bLen = b.length;

        // Two rows of the DP matrix
        let prevRow = new Array<number>(aLen + 1);
        let currRow = new Array<number>(aLen + 1);

        // Initialize first row
        for (let j = 0; j <= aLen; j++) {
            prevRow[j] = j;
        }

        for (let i = 1; i <= bLen; i++) {
            currRow[0] = i;
            for (let j = 1; j <= aLen; j++) {
                const cost = a[j - 1] === b[i - 1] ? 0 : 1;
                currRow[j] = Math.min(
                    prevRow[j]! + 1,       // deletion
                    currRow[j - 1]! + 1,   // insertion
                    prevRow[j - 1]! + cost  // substitution
                );
            }
            // Swap rows
            const tmp = prevRow;
            prevRow = currRow;
            currRow = tmp;
        }

        return prevRow[aLen]!;
    }

    /**
     * Split a name into tokens for token-level comparison.
     * Handles camelCase, PascalCase, and snake_case.
     */
    private tokenizeName(name: string): Set<string> {
        const parts = name
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(p => p.length > 0);
        return new Set(parts);
    }
}

export const symbolLineageEngine = new SymbolLineageEngine();
