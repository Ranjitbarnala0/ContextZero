/**
 * ContextZero — Semantic Engine
 *
 * Orchestrates multi-view embedding generation, IDF corpus computation,
 * MinHash indexing, and semantic similarity queries.
 *
 * This is the native replacement for external embedding APIs.
 * It powers Homolog Dimension 1 (semantic intent similarity) and
 * provides candidates for Dimension 2 (normalized logic similarity).
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { BatchLoader } from '../db-driver/batch-loader';
import { firstRow, jsonField } from '../db-driver/result';
import { Logger } from '../logger';
import { BehaviorHint, BehavioralProfile, ContractHint, ContractProfile } from '../types';
import {
    tokenizeName,
    tokenizeBody,
    tokenizeSignature,
    tokenizeBehavior,
    tokenizeContract,
} from './tokenizer';
import {
    SparseVector,
    computeTF,
    computeIDF,
    computeTFIDF,
    cosineSimilarity,
    generateMinHash,
    estimateJaccardFromMinHash,
    multiViewSimilarity,
    computeBandHashes,
    LSH_ROWS_PER_BAND,
} from './similarity';

const log = new Logger('semantic-engine');

/** The five semantic view types used by the engine */
const VIEW_TYPES = ['name', 'body', 'signature', 'behavior', 'contract'] as const;
type ViewType = typeof VIEW_TYPES[number];

/** Default weights for multi-view similarity (aligned with HOMOLOG_WEIGHTS dimension 1) */
const DEFAULT_VIEW_WEIGHTS: Record<string, number> = {
    name: 0.25,
    body: 0.30,
    signature: 0.20,
    behavior: 0.15,
    contract: 0.10,
};

/** Number of MinHash permutations for LSH */
const MINHASH_PERMUTATIONS = 128;

/**
 * Max PostgreSQL parameters per query (~32K limit, stay well below).
 * semantic_vectors: 6 params per row, lsh_bands: 4 params per row.
 */
const MAX_PG_PARAMS = 30000;
const LSH_BAND_COLS = 4; // symbol_version_id, view_type, band_index, band_hash
const SEMANTIC_VEC_COLS = 6; // vector_id, symbol_version_id, view_type, sparse_vector, minhash_signature, token_count
const MAX_LSH_ROWS_PER_INSERT = Math.floor(MAX_PG_PARAMS / LSH_BAND_COLS); // ~7500
const MAX_VEC_ROWS_PER_INSERT = Math.floor(MAX_PG_PARAMS / SEMANTIC_VEC_COLS); // ~5000

/**
 * Build a multi-row INSERT ... ON CONFLICT for semantic_vectors.
 * Returns one or more statements (chunked if row count exceeds PG param limit).
 */
function buildMultiRowVectorInsert(
    rows: { vectorId: string; symbolVersionId: string; viewType: string; sparseJson: string; minhash: number[]; tokenCount: number }[],
): { text: string; params: unknown[] }[] {
    const statements: { text: string; params: unknown[] }[] = [];
    for (let offset = 0; offset < rows.length; offset += MAX_VEC_ROWS_PER_INSERT) {
        const chunk = rows.slice(offset, offset + MAX_VEC_ROWS_PER_INSERT);
        const valuesClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        for (const r of chunk) {
            valuesClauses.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
            params.push(r.vectorId, r.symbolVersionId, r.viewType, r.sparseJson, r.minhash, r.tokenCount);
            idx += SEMANTIC_VEC_COLS;
        }
        statements.push({
            text: `INSERT INTO semantic_vectors
                   (vector_id, symbol_version_id, view_type, sparse_vector, minhash_signature, token_count)
                   VALUES ${valuesClauses.join(', ')}
                   ON CONFLICT (symbol_version_id, view_type)
                   DO UPDATE SET sparse_vector = EXCLUDED.sparse_vector,
                                 minhash_signature = EXCLUDED.minhash_signature,
                                 token_count = EXCLUDED.token_count,
                                 created_at = NOW()`,
            params,
        });
    }
    return statements;
}

/**
 * Build a multi-row INSERT ... ON CONFLICT for lsh_bands.
 * Returns one or more statements (chunked if row count exceeds PG param limit).
 */
function buildMultiRowBandInsert(
    rows: { symbolVersionId: string; viewType: string; bandIndex: number; bandHash: number }[],
): { text: string; params: unknown[] }[] {
    const statements: { text: string; params: unknown[] }[] = [];
    for (let offset = 0; offset < rows.length; offset += MAX_LSH_ROWS_PER_INSERT) {
        const chunk = rows.slice(offset, offset + MAX_LSH_ROWS_PER_INSERT);
        const valuesClauses: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        for (const r of chunk) {
            valuesClauses.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3})`);
            params.push(r.symbolVersionId, r.viewType, r.bandIndex, r.bandHash);
            idx += LSH_BAND_COLS;
        }
        statements.push({
            text: `INSERT INTO lsh_bands (symbol_version_id, view_type, band_index, band_hash)
                   VALUES ${valuesClauses.join(', ')}
                   ON CONFLICT (symbol_version_id, view_type, band_index)
                   DO UPDATE SET band_hash = EXCLUDED.band_hash`,
            params,
        });
    }
    return statements;
}

class SemanticEngine {

    /**
     * Convert pre-loaded behavioral and contract profiles into the BehaviorHint[]
     * and ContractHint used by the tokenizer.
     * Extracted to avoid duplication across batch embedding paths.
     */
    private _buildHintsFromProfiles(
        name: string,
        bp: BehavioralProfile | undefined,
        cp: ContractProfile | undefined,
    ): { behaviorHints: BehaviorHint[]; contractHint: ContractHint | null } {
        const behaviorHints: BehaviorHint[] = [];
        if (bp) {
            const addHints = (items: string[], hintType: BehaviorHint['hint_type']) => {
                const arr = Array.isArray(items) ? items : [];
                for (const detail of arr) {
                    behaviorHints.push({ symbol_key: name, hint_type: hintType, detail, line: 0 });
                }
            };
            addHints(bp.db_reads, 'db_read');
            addHints(bp.db_writes, 'db_write');
            addHints(bp.network_calls, 'network_call');
            addHints(bp.file_io, 'file_io');
            addHints(bp.cache_ops, 'cache_op');
            addHints(bp.auth_operations, 'auth_check');
            addHints(bp.validation_operations, 'validation');
            addHints(bp.exception_profile, 'throws');
        }

        let contractHint: ContractHint | null = null;
        if (cp) {
            contractHint = {
                symbol_key: name,
                input_types: Array.isArray(cp.input_contract) ? cp.input_contract : [String(cp.input_contract || '')],
                output_type: String(cp.output_contract || ''),
                thrown_types: Array.isArray(cp.error_contract) ? cp.error_contract : [String(cp.error_contract || '')],
                decorators: Array.isArray(cp.schema_refs) ? cp.schema_refs : [],
            };
        }

        return { behaviorHints, contractHint };
    }

    /**
     * Compute the 5-view token streams for a symbol WITHOUT persisting to DB.
     * Returns the raw token arrays keyed by view type.
     * Used by single-pass batch embedding to build in-memory token maps
     * before IDF computation.
     */
    private computeTokenStreams(
        code: string,
        name: string,
        signature: string,
        behaviorHints: BehaviorHint[],
        contractHint: ContractHint | null,
    ): Record<ViewType, string[]> {
        return {
            name: tokenizeName(name),
            body: tokenizeBody(code),
            signature: tokenizeSignature(signature),
            behavior: tokenizeBehavior(
                behaviorHints.map((h) => ({ hint_type: h.hint_type, detail: h.detail })),
            ),
            contract: contractHint
                ? tokenizeContract({
                      input_types: contractHint.input_types,
                      output_type: contractHint.output_type,
                      thrown_types: contractHint.thrown_types,
                      decorators: contractHint.decorators,
                  })
                : [],
        };
    }

    /**
     * Compute IDF scores per view type from in-memory token streams.
     * Avoids the DB round-trip that computeSnapshotIDF requires.
     * Also persists the computed IDF into idf_corpus for use by
     * searchByQuery, embedSymbol, and other callers.
     */
    private async computeIDFFromTokens(
        snapshotId: string,
        allTokenStreams: Map<string, Record<ViewType, string[]>>,
    ): Promise<Record<ViewType, Record<string, number>>> {
        const totalDocs = allTokenStreams.size;
        const idfByView: Record<string, Record<string, number>> = {} as Record<ViewType, Record<string, number>>;

        for (const viewType of VIEW_TYPES) {
            // Build token sets from in-memory streams
            const tokenSets: Set<string>[] = [];
            for (const viewTokens of allTokenStreams.values()) {
                tokenSets.push(new Set(viewTokens[viewType]));
            }

            if (tokenSets.length === 0) {
                idfByView[viewType] = {};
                continue;
            }

            // Compute IDF
            const idfScores = computeIDF(tokenSets, totalDocs);
            idfByView[viewType] = idfScores;

            // Build document count map for DB persistence
            const tokenDocCounts: Record<string, number> = {};
            for (const tokenSet of tokenSets) {
                for (const token of tokenSet) {
                    tokenDocCounts[token] = (tokenDocCounts[token] || 0) + 1;
                }
            }

            // Persist to idf_corpus for other callers (searchByQuery, embedSymbol)
            const corpusId = uuidv4();
            await db.query(
                `INSERT INTO idf_corpus (corpus_id, snapshot_id, view_type, document_count, token_document_counts)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (snapshot_id, view_type)
                 DO UPDATE SET document_count = $4, token_document_counts = $5, computed_at = NOW()`,
                [corpusId, snapshotId, viewType, totalDocs, JSON.stringify(tokenDocCounts)],
            );
        }

        return idfByView as Record<ViewType, Record<string, number>>;
    }

    /**
     * Compute IDF statistics for an entire snapshot, per view type.
     * Loads all tokens from semantic_vectors for the given snapshot,
     * computes IDF, and upserts into idf_corpus.
     */
    async computeSnapshotIDF(snapshotId: string): Promise<void> {
        const done = log.startTimer('computeSnapshotIDF', { snapshotId });

        try {
            for (const viewType of VIEW_TYPES) {
                // Load all sparse vectors for this view type within the snapshot
                const result = await db.query(
                    `SELECT sv.sparse_vector
                     FROM semantic_vectors sv
                     JOIN symbol_versions symv ON symv.symbol_version_id = sv.symbol_version_id
                     WHERE symv.snapshot_id = $1 AND sv.view_type = $2
                     LIMIT 100000`,
                    [snapshotId, viewType],
                );

                const rows = result.rows;
                const totalDocs = rows.length;

                if (totalDocs === 0) {
                    log.debug('No documents found for IDF computation', { snapshotId, viewType });
                    continue;
                }

                // Build token sets from sparse vector keys
                const tokenSets: Set<string>[] = [];
                for (const row of rows) {
                    let sparseVec: Record<string, number>;
                    try {
                        sparseVec = typeof row.sparse_vector === 'string'
                            ? JSON.parse(row.sparse_vector)
                            : row.sparse_vector;
                    } catch (error) {
                        log.debug('Skipping corrupt semantic vector during IDF computation', {
                            snapshotId,
                            viewType,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        continue;
                    }
                    tokenSets.push(new Set(Object.keys(sparseVec)));
                }

                // Compute IDF — use tokenSets.length (actual valid documents)
                // instead of totalDocs (which includes corrupt vectors that were skipped)
                const idfScores = computeIDF(tokenSets, tokenSets.length);

                // Build document count map for storage
                const tokenDocCounts: Record<string, number> = {};
                for (const tokenSet of tokenSets) {
                    for (const token of tokenSet) {
                        tokenDocCounts[token] = (tokenDocCounts[token] || 0) + 1;
                    }
                }

                // Upsert into idf_corpus
                const corpusId = uuidv4();
                await db.query(
                    `INSERT INTO idf_corpus (corpus_id, snapshot_id, view_type, document_count, token_document_counts)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (snapshot_id, view_type)
                     DO UPDATE SET document_count = $4, token_document_counts = $5, computed_at = NOW()`,
                    [corpusId, snapshotId, viewType, totalDocs, JSON.stringify(tokenDocCounts)],
                );

                log.debug('IDF computed for view', {
                    snapshotId,
                    viewType,
                    totalDocs,
                    uniqueTokens: Object.keys(idfScores).length,
                });
            }

            done();
        } catch (error) {
            log.error('Failed to compute snapshot IDF', error, { snapshotId });
            throw error;
        }
    }

    /**
     * Embed a single symbol version: generate 5 view token streams,
     * compute TF-IDF vectors, generate MinHash signatures, persist to DB.
     */
    async embedSymbol(
        symbolVersionId: string,
        code: string,
        name: string,
        signature: string,
        behaviorHints: BehaviorHint[],
        contractHint: ContractHint | null,
    ): Promise<void> {
        const done = log.startTimer('embedSymbol', { symbolVersionId });

        try {
            // Step 1: Generate token streams for all 5 views
            const viewTokens: Record<ViewType, string[]> = {
                name: tokenizeName(name),
                body: tokenizeBody(code),
                signature: tokenizeSignature(signature),
                behavior: tokenizeBehavior(
                    behaviorHints.map((h) => ({ hint_type: h.hint_type, detail: h.detail })),
                ),
                contract: contractHint
                    ? tokenizeContract({
                          input_types: contractHint.input_types,
                          output_type: contractHint.output_type,
                          thrown_types: contractHint.thrown_types,
                          decorators: contractHint.decorators,
                      })
                    : [],
            };

            // Step 2: Load IDF from DB (try to find corpus for this symbol's snapshot)
            const snapshotResult = await db.query(
                `SELECT snapshot_id FROM symbol_versions WHERE symbol_version_id = $1`,
                [symbolVersionId],
            );
            const snapshotId = snapshotResult.rows[0]?.snapshot_id;

            // Load IDF per view type if available
            const idfByView: Record<string, Record<string, number>> = {};
            if (snapshotId) {
                const idfResult = await db.query(
                    `SELECT view_type, document_count, token_document_counts
                     FROM idf_corpus
                     WHERE snapshot_id = $1`,
                    [snapshotId],
                );
                for (const row of idfResult.rows) {
                    const docCounts: Record<string, number> =
                        typeof row.token_document_counts === 'string'
                            ? JSON.parse(row.token_document_counts)
                            : row.token_document_counts;
                    const totalDocs = row.document_count as number;

                    // Reconstruct IDF from stored doc counts
                    const idf: Record<string, number> = {};
                    for (const [token, freq] of Object.entries(docCounts)) {
                        idf[token] = Math.log(1 + totalDocs / (1 + freq));
                    }
                    idfByView[row.view_type as string] = idf;
                }
            }

            // Step 3: Compute TF-IDF and MinHash for each view, prepare multi-row inserts
            const vectorRows: { vectorId: string; symbolVersionId: string; viewType: string; sparseJson: string; minhash: number[]; tokenCount: number }[] = [];
            const bandRows: { symbolVersionId: string; viewType: string; bandIndex: number; bandHash: number }[] = [];

            for (const viewType of VIEW_TYPES) {
                const tokens = viewTokens[viewType];
                const tf = computeTF(tokens);
                const idf = idfByView[viewType] || {};
                const tfidf = computeTFIDF(tf, idf);

                const tokenSet = new Set(tokens);
                const minhash = generateMinHash(tokenSet, MINHASH_PERMUTATIONS);

                vectorRows.push({
                    vectorId: uuidv4(),
                    symbolVersionId,
                    viewType,
                    sparseJson: JSON.stringify(tfidf),
                    minhash,
                    tokenCount: tokens.length,
                });

                // Compute LSH band hashes for sub-linear retrieval
                const bandHashes = computeBandHashes(minhash, LSH_ROWS_PER_BAND);
                for (let b = 0; b < bandHashes.length; b++) {
                    bandRows.push({ symbolVersionId, viewType, bandIndex: b, bandHash: bandHashes[b] ?? 0 });
                }
            }

            // Step 4: Multi-row INSERT — ~2 statements instead of ~85
            const statements = [
                ...buildMultiRowVectorInsert(vectorRows),
                ...buildMultiRowBandInsert(bandRows),
            ];
            await db.batchInsert(statements);

            done({ views: VIEW_TYPES.length, totalTokens: Object.values(viewTokens).reduce((s, t) => s + t.length, 0) });
        } catch (error) {
            log.error('Failed to embed symbol', error, { symbolVersionId });
            throw error;
        }
    }

    /**
     * Find semantic candidates for a symbol using LSH banding.
     * Computes band hashes from the target's MinHash signatures, queries the
     * lsh_bands table for symbols sharing at least one band, then re-scores
     * matches with weighted Jaccard for accurate ranking.
     *
     * Falls back to linear scan if no LSH bands exist (graceful degradation).
     */
    async findSemanticCandidates(
        symbolVersionId: string,
        snapshotId: string,
        topK: number = 50,
    ): Promise<{ svId: string; estimatedSimilarity: number }[]> {
        const done = log.startTimer('findSemanticCandidates', { symbolVersionId, snapshotId, topK });

        try {
            // Step 1: Load target MinHash signatures (all views)
            const targetResult = await db.query(
                `SELECT view_type, minhash_signature
                 FROM semantic_vectors
                 WHERE symbol_version_id = $1`,
                [symbolVersionId],
            );

            if (targetResult.rows.length === 0) {
                log.warn('No semantic vectors found for target symbol', { symbolVersionId });
                done({ candidates: 0 });
                return [];
            }

            const targetMinHashes: Record<string, number[]> = {};
            for (const row of targetResult.rows) {
                targetMinHashes[row.view_type as string] = row.minhash_signature as number[];
            }

            // Step 2: Compute band hashes for the target's MinHash signatures
            const targetBandHashes: Record<string, number[]> = {};
            for (const [viewType, minhash] of Object.entries(targetMinHashes)) {
                targetBandHashes[viewType] = computeBandHashes(minhash, LSH_ROWS_PER_BAND);
            }

            // Step 3: Check if LSH bands have been built; if not, fall back to linear scan
            const lshCheck = await db.query(
                `SELECT 1 FROM lsh_bands lb
                 JOIN symbol_versions sv ON sv.symbol_version_id = lb.symbol_version_id
                 WHERE sv.snapshot_id = $1
                 LIMIT 1`,
                [snapshotId],
            );

            if (lshCheck.rows.length === 0) {
                log.info('No LSH bands found for snapshot, falling back to linear scan', { snapshotId });
                const result = await this._findSemanticCandidatesLinear(
                    symbolVersionId, snapshotId, topK, targetMinHashes,
                );
                done({ candidates: result.length, mode: 'linear-fallback' });
                return result;
            }

            // Step 4: For each view type, query lsh_bands for candidate matches
            const viewTypes = Object.keys(targetBandHashes);
            const candidateSvIds = new Set<string>();

            const bandQueries = viewTypes.map(async (viewType) => {
                const bands = targetBandHashes[viewType]!;
                if (bands.length === 0) return;

                // Build VALUES list for (band_index, band_hash) tuples
                const valueEntries: string[] = [];
                const queryParams: unknown[] = [snapshotId, symbolVersionId, viewType];
                let paramIdx = 4; // $1=snapshotId, $2=symbolVersionId, $3=viewType

                for (let b = 0; b < bands.length; b++) {
                    valueEntries.push(`($${paramIdx}::smallint, $${paramIdx + 1}::int)`);
                    queryParams.push(b, bands[b]);
                    paramIdx += 2;
                }

                const query = `
                    SELECT DISTINCT lb.symbol_version_id
                    FROM lsh_bands lb
                    JOIN symbol_versions sv ON sv.symbol_version_id = lb.symbol_version_id
                    WHERE sv.snapshot_id = $1
                    AND lb.symbol_version_id != $2
                    AND lb.view_type = $3
                    AND (lb.band_index, lb.band_hash) IN (VALUES ${valueEntries.join(', ')})
                `;

                const result = await db.query(query, queryParams);
                for (const row of result.rows) {
                    candidateSvIds.add(row.symbol_version_id as string);
                }
            });

            await Promise.all(bandQueries);

            if (candidateSvIds.size === 0) {
                log.debug('LSH banding found no candidates', { symbolVersionId, snapshotId });
                done({ candidates: 0, mode: 'lsh' });
                return [];
            }

            // Step 5: Load MinHash signatures for LSH candidate symbols (chunked)
            const candidateIds = Array.from(candidateSvIds);
            const CHUNK_SIZE = 5000;
            const candidateMinHashes: Map<string, Record<string, number[]>> = new Map();

            for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
                const chunk = candidateIds.slice(i, i + CHUNK_SIZE);
                const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
                const minhashResult = await db.query(
                    `SELECT symbol_version_id, view_type, minhash_signature
                     FROM semantic_vectors
                     WHERE symbol_version_id IN (${placeholders})`,
                    chunk,
                );

                for (const row of minhashResult.rows) {
                    const svId = row.symbol_version_id as string;
                    if (!candidateMinHashes.has(svId)) {
                        candidateMinHashes.set(svId, {});
                    }
                    candidateMinHashes.get(svId)![row.view_type as string] = row.minhash_signature as number[];
                }
            }

            // Step 6: Re-score candidates with weighted Jaccard similarity
            const scores: { svId: string; estimatedSimilarity: number }[] = [];

            for (const [svId, viewMinHashes] of candidateMinHashes) {
                let totalSim = 0;
                let totalWeight = 0;

                for (const [viewType, weight] of Object.entries(DEFAULT_VIEW_WEIGHTS)) {
                    const targetSig = targetMinHashes[viewType];
                    const candidateSig = viewMinHashes[viewType];

                    totalWeight += weight;

                    if (targetSig && candidateSig) {
                        totalSim += weight * estimateJaccardFromMinHash(targetSig, candidateSig);
                    }
                }

                const estimatedSimilarity = totalWeight > 0 ? totalSim / totalWeight : 0;
                scores.push({ svId, estimatedSimilarity });
            }

            // Sort by similarity descending, take top-K
            scores.sort((a, b) => b.estimatedSimilarity - a.estimatedSimilarity);
            const topCandidates = scores.slice(0, topK);

            done({
                candidates: topCandidates.length,
                lshMatches: candidateSvIds.size,
                mode: 'lsh',
            });
            return topCandidates;
        } catch (error) {
            log.error('Failed to find semantic candidates', error, { symbolVersionId, snapshotId });
            throw error;
        }
    }

    /**
     * Linear fallback for findSemanticCandidates when LSH bands haven't been built.
     * Loads ALL MinHash signatures in the snapshot and compares O(N).
     * Kept as graceful degradation for snapshots without LSH band data.
     */
    private async _findSemanticCandidatesLinear(
        symbolVersionId: string,
        snapshotId: string,
        topK: number,
        targetMinHashes: Record<string, number[]>,
    ): Promise<{ svId: string; estimatedSimilarity: number }[]> {
        // Load all other symbols' MinHash signatures in the same snapshot
        const candidatesResult = await db.query(
            `SELECT sv.symbol_version_id, sv.view_type, sv.minhash_signature
             FROM semantic_vectors sv
             JOIN symbol_versions symv ON symv.symbol_version_id = sv.symbol_version_id
             WHERE symv.snapshot_id = $1 AND sv.symbol_version_id != $2
             LIMIT 50000`,
            [snapshotId, symbolVersionId],
        );

        // Group by symbol_version_id
        const candidateMinHashes: Map<string, Record<string, number[]>> = new Map();
        for (const row of candidatesResult.rows) {
            const svId = row.symbol_version_id as string;
            if (!candidateMinHashes.has(svId)) {
                candidateMinHashes.set(svId, {});
            }
            candidateMinHashes.get(svId)![row.view_type as string] = row.minhash_signature as number[];
        }

        // Compute estimated similarity for each candidate
        const scores: { svId: string; estimatedSimilarity: number }[] = [];

        for (const [svId, viewMinHashes] of candidateMinHashes) {
            let totalSim = 0;
            let totalWeight = 0;

            for (const [viewType, weight] of Object.entries(DEFAULT_VIEW_WEIGHTS)) {
                const targetSig = targetMinHashes[viewType];
                const candidateSig = viewMinHashes[viewType];

                totalWeight += weight;

                if (targetSig && candidateSig) {
                    totalSim += weight * estimateJaccardFromMinHash(targetSig, candidateSig);
                }
            }

            const estimatedSimilarity = totalWeight > 0 ? totalSim / totalWeight : 0;
            scores.push({ svId, estimatedSimilarity });
        }

        // Sort by similarity descending, take top-K
        scores.sort((a, b) => b.estimatedSimilarity - a.estimatedSimilarity);
        return scores.slice(0, topK);
    }

    /**
     * Compute precise semantic similarity between two symbol versions
     * using multi-view weighted cosine similarity on TF-IDF vectors.
     */
    async computeSemanticSimilarity(
        svIdA: string,
        svIdB: string,
    ): Promise<number> {
        try {
            // Load TF-IDF vectors for both symbols
            const [resultA, resultB] = await Promise.all([
                db.query(
                    `SELECT view_type, sparse_vector FROM semantic_vectors WHERE symbol_version_id = $1`,
                    [svIdA],
                ),
                db.query(
                    `SELECT view_type, sparse_vector FROM semantic_vectors WHERE symbol_version_id = $1`,
                    [svIdB],
                ),
            ]);

            if (resultA.rows.length === 0 || resultB.rows.length === 0) {
                log.warn('Missing semantic vectors for similarity computation', {
                    svIdA,
                    svIdB,
                    vectorsA: resultA.rows.length,
                    vectorsB: resultB.rows.length,
                });
                return 0;
            }

            const viewsA: Map<string, SparseVector> = new Map();
            for (const row of resultA.rows) {
                let vec: SparseVector;
                try {
                    vec = typeof row.sparse_vector === 'string'
                        ? JSON.parse(row.sparse_vector) : row.sparse_vector;
                } catch (error) {
                    log.debug('Skipping corrupt semantic vector for similarity source', {
                        svIdA,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }
                viewsA.set(row.view_type as string, vec);
            }

            const viewsB: Map<string, SparseVector> = new Map();
            for (const row of resultB.rows) {
                let vec: SparseVector;
                try {
                    vec = typeof row.sparse_vector === 'string'
                        ? JSON.parse(row.sparse_vector) : row.sparse_vector;
                } catch (error) {
                    log.debug('Skipping corrupt semantic vector for similarity target', {
                        svIdB,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }
                viewsB.set(row.view_type as string, vec);
            }

            return multiViewSimilarity(viewsA, viewsB, DEFAULT_VIEW_WEIGHTS);
        } catch (error) {
            log.error('Failed to compute semantic similarity', error, { svIdA, svIdB });
            throw error;
        }
    }

    /**
     * Compute body-only similarity between two symbols using MinHash Jaccard.
     * This gives graduated similarity (0.0–1.0) for function bodies that share
     * logic but aren't byte-identical — unlike hash comparison which is binary.
     */
    async computeBodySimilarity(svIdA: string, svIdB: string): Promise<number> {
        const [resultA, resultB] = await Promise.all([
            db.query(
                `SELECT minhash_signature FROM semantic_vectors WHERE symbol_version_id = $1 AND view_type = 'body'`,
                [svIdA],
            ),
            db.query(
                `SELECT minhash_signature FROM semantic_vectors WHERE symbol_version_id = $1 AND view_type = 'body'`,
                [svIdB],
            ),
        ]);

        if (resultA.rows.length === 0 || resultB.rows.length === 0) return 0;

        const rowA = firstRow(resultA);
        const rowB = firstRow(resultB);
        const sigA = Array.isArray(rowA?.['minhash_signature']) ? rowA['minhash_signature'] as number[] : null;
        const sigB = Array.isArray(rowB?.['minhash_signature']) ? rowB['minhash_signature'] as number[] : null;
        if (!sigA || !sigB) return 0;

        return estimateJaccardFromMinHash(sigA, sigB);
    }

    /**
     * Batch-embed all symbols in a snapshot using a single-pass architecture.
     *
     * Instead of the old double-pass approach (embed with IDF=1.0, compute IDF,
     * re-embed with real IDF), this uses three in-memory phases:
     *
     *   Phase 1: Compute all 5-view token streams in memory (no DB writes)
     *   Phase 2: Compute IDF directly from in-memory token streams (no DB reads)
     *   Phase 3: Single persist pass — compute TF-IDF with real IDF, write once
     *
     * This halves DB writes and eliminates the redundant re-embedding pass.
     * Returns the number of symbols embedded.
     */
    async batchEmbedSnapshot(snapshotId: string): Promise<number> {
        const done = log.startTimer('batchEmbedSnapshot', { snapshotId });

        try {
            // Load all symbol versions for this snapshot with their data
            const symbolsResult = await db.query(
                `SELECT
                    symv.symbol_version_id,
                    symv.signature,
                    symv.summary,
                    symv.body_source,
                    s.canonical_name,
                    f.path AS file_path
                 FROM symbol_versions symv
                 JOIN symbols s ON s.symbol_id = symv.symbol_id
                 JOIN files f ON f.file_id = symv.file_id
                 WHERE symv.snapshot_id = $1`,
                [snapshotId],
            );

            const symbols = symbolsResult.rows;
            log.info('Starting batch embedding (single-pass)', { snapshotId, symbolCount: symbols.length });

            // Pre-load ALL behavioral and contract profiles in 2 bulk queries
            const allSvIds = symbols.map(s => s.symbol_version_id as string);
            const loader = new BatchLoader();
            const allBehavioral = await loader.loadBehavioralProfiles(allSvIds);
            const allContracts = await loader.loadContractProfiles(allSvIds);

            // ── Phase 1: Compute token streams in memory ─────────────────────
            // Build Map<symbolVersionId, Record<ViewType, string[]>>
            const allTokenStreams = new Map<string, Record<ViewType, string[]>>();

            for (const sym of symbols) {
                const svId = (sym.symbol_version_id as string) ?? '';
                const name = (sym.canonical_name as string) ?? '';
                const signature = (sym.signature as string) ?? '';

                const { behaviorHints, contractHint } = this._buildHintsFromProfiles(
                    name,
                    allBehavioral.get(svId),
                    allContracts.get(svId),
                );

                // Use stored body_source for accurate TF-IDF embedding.
                // Falls back to summary only when body_source is not available
                // (e.g., symbols ingested before the body_source migration).
                // Nullish coalescing: empty string is valid body (interfaces, type aliases)
                const codeBody = (sym.body_source as string | null) ?? (sym.summary as string) ?? '';

                const tokenStreams = this.computeTokenStreams(
                    codeBody, name, signature, behaviorHints, contractHint,
                );
                allTokenStreams.set(svId, tokenStreams);
            }

            log.info('Phase 1 complete: token streams computed in memory', {
                snapshotId,
                symbolCount: allTokenStreams.size,
            });

            // ── Phase 2: Compute IDF from in-memory token streams ────────────
            // No DB read needed — IDF is derived directly from the token sets.
            // Also persists to idf_corpus for use by searchByQuery and embedSymbol.
            const idfByView = await this.computeIDFFromTokens(snapshotId, allTokenStreams);

            log.info('Phase 2 complete: IDF computed from in-memory tokens', { snapshotId });

            // ── Phase 3: Single persist pass with real IDF ───────────────────
            // Accumulate multi-row INSERT data across symbols, flushing when
            // we approach the PostgreSQL parameter limit (~30K params).
            // This reduces ~85 statements/symbol to ~2 statements per flush.
            const FLUSH_SYMBOL_BATCH = 200; // flush every N symbols
            let embedded = 0;
            let pendingVectorRows: { vectorId: string; symbolVersionId: string; viewType: string; sparseJson: string; minhash: number[]; tokenCount: number }[] = [];
            let pendingBandRows: { symbolVersionId: string; viewType: string; bandIndex: number; bandHash: number }[] = [];

            const flushPending = async () => {
                if (pendingVectorRows.length === 0 && pendingBandRows.length === 0) return;
                const statements = [
                    ...buildMultiRowVectorInsert(pendingVectorRows),
                    ...buildMultiRowBandInsert(pendingBandRows),
                ];
                await db.batchInsert(statements);
                pendingVectorRows = [];
                pendingBandRows = [];
            };

            for (const sym of symbols) {
                const svId = sym.symbol_version_id as string;
                const viewTokens = allTokenStreams.get(svId)!;

                for (const viewType of VIEW_TYPES) {
                    const tokens = viewTokens[viewType];
                    const tf = computeTF(tokens);
                    const idf = idfByView[viewType] || {};
                    const tfidf = computeTFIDF(tf, idf);

                    const tokenSet = new Set(tokens);
                    const minhash = generateMinHash(tokenSet, MINHASH_PERMUTATIONS);

                    pendingVectorRows.push({
                        vectorId: uuidv4(),
                        symbolVersionId: svId,
                        viewType,
                        sparseJson: JSON.stringify(tfidf),
                        minhash,
                        tokenCount: tokens.length,
                    });

                    // Compute LSH band hashes for sub-linear retrieval
                    const bandHashes = computeBandHashes(minhash, LSH_ROWS_PER_BAND);
                    for (let b = 0; b < bandHashes.length; b++) {
                        pendingBandRows.push({ symbolVersionId: svId, viewType, bandIndex: b, bandHash: bandHashes[b] ?? 0 });
                    }
                }

                embedded++;

                // Flush periodically to stay within PG parameter limits
                if (embedded % FLUSH_SYMBOL_BATCH === 0) {
                    await flushPending();
                    log.info('Batch embedding progress', { snapshotId, embedded, total: symbols.length });
                }
            }

            // Final flush for remaining symbols
            await flushPending();

            log.info('Phase 3 complete: all vectors persisted with real IDF', {
                snapshotId,
                embedded,
            });

            done({ embedded });
            return embedded;
        } catch (error) {
            log.error('Failed to batch embed snapshot', error, { snapshotId });
            throw error;
        }
    }

    /**
     * Search symbols by a free-text query string using TF-IDF cosine similarity.
     *
     * Memory-efficient: instead of loading ALL vectors for the snapshot,
     * this method:
     *   1. Tokenizes the query and computes its TF-IDF vector + MinHash signature
     *   2. Uses LSH band lookup to find candidate symbols (sub-linear)
     *   3. Computes cosine similarity only against those candidates
     *   4. Falls back to batched scanning (500 at a time) if no LSH candidates
     *
     * Never loads more than ~1000 vectors into memory at once.
     */
    async searchByQuery(
        query: string,
        snapshotId: string,
        limit: number = 15,
    ): Promise<{ svId: string; similarity: number }[]> {
        const done = log.startTimer('searchByQuery', { snapshotId, limit });

        try {
            // Step 1: Tokenize the query using the body tokenizer
            const queryTokens = tokenizeBody(query);
            if (queryTokens.length === 0) {
                done({ candidates: 0, mode: 'no-tokens' });
                return [];
            }

            // Step 2: Compute query TF
            const queryTF = computeTF(queryTokens);

            // Step 3: Load IDF for body view from this snapshot
            const idfResult = await db.query(
                `SELECT document_count, token_document_counts FROM idf_corpus
                 WHERE snapshot_id = $1 AND view_type = 'body'`,
                [snapshotId],
            );

            const queryIDF: Record<string, number> = {};
            if (idfResult.rows.length > 0) {
                const docCounts = jsonField<Record<string, number>>(firstRow(idfResult), 'token_document_counts') ?? {};
                const totalDocs = idfResult.rows[0].document_count as number;
                for (const [token, freq] of Object.entries(docCounts)) {
                    queryIDF[token] = Math.log(1 + totalDocs / (1 + freq));
                }
                // OOV query tokens get maximum IDF — rare terms are highly discriminative
                const defaultIDF = Math.log(1 + totalDocs);
                for (const token of Object.keys(queryTF)) {
                    if (!(token in queryIDF)) {
                        queryIDF[token] = defaultIDF;
                    }
                }
            }

            // Step 4: Compute query TF-IDF vector
            const queryVector = computeTFIDF(queryTF, queryIDF);

            // Step 5: Compute MinHash for query tokens and look up LSH candidates
            const queryTokenSet = new Set(queryTokens);
            const queryMinHash = generateMinHash(queryTokenSet, MINHASH_PERMUTATIONS);
            const queryBandHashes = computeBandHashes(queryMinHash, LSH_ROWS_PER_BAND);

            // Check if LSH bands exist for this snapshot
            const lshCheck = await db.query(
                `SELECT 1 FROM lsh_bands lb
                 JOIN symbol_versions sv ON sv.symbol_version_id = lb.symbol_version_id
                 WHERE sv.snapshot_id = $1
                 LIMIT 1`,
                [snapshotId],
            );

            let candidateSvIds: string[] = [];

            if (lshCheck.rows.length > 0 && queryBandHashes.length > 0) {
                // LSH candidate retrieval: find symbols sharing at least one band hash
                const valueEntries: string[] = [];
                const queryParams: unknown[] = [snapshotId];
                let paramIdx = 2;

                for (let b = 0; b < queryBandHashes.length; b++) {
                    valueEntries.push(`($${paramIdx}::smallint, $${paramIdx + 1}::int)`);
                    queryParams.push(b, queryBandHashes[b]);
                    paramIdx += 2;
                }

                const lshResult = await db.query(`
                    SELECT DISTINCT lb.symbol_version_id
                    FROM lsh_bands lb
                    JOIN symbol_versions sv ON sv.symbol_version_id = lb.symbol_version_id
                    WHERE sv.snapshot_id = $1
                    AND lb.view_type = 'body'
                    AND (lb.band_index, lb.band_hash) IN (VALUES ${valueEntries.join(', ')})
                `, queryParams);

                candidateSvIds = lshResult.rows.map(r => r.symbol_version_id as string);
                log.debug('LSH candidates found for query', { count: candidateSvIds.length, snapshotId });
            }

            // Step 6: Score candidates by cosine similarity
            if (candidateSvIds.length > 0) {
                // Load vectors only for LSH candidates (chunked to max 1000)
                const scores = await this._scoreCandidatesByVector(
                    candidateSvIds, queryVector, limit,
                );
                done({ candidates: scores.length, mode: 'lsh', lshHits: candidateSvIds.length });
                return scores;
            }

            // Step 7: Fallback — no LSH candidates. Scan in batches of 500.
            log.debug('No LSH candidates, falling back to batched scan', { snapshotId });
            const scores = await this._batchedVectorScan(snapshotId, queryVector, limit);
            done({ candidates: scores.length, mode: 'batched-fallback' });
            return scores;
        } catch (error) {
            log.error('Failed to search by query', error, { snapshotId });
            throw error;
        }
    }

    /**
     * Load sparse vectors for a specific set of candidate symbol_version_ids
     * and compute cosine similarity against the query vector.
     * Processes in chunks of 500 to limit memory.
     */
    private async _scoreCandidatesByVector(
        candidateSvIds: string[],
        queryVector: SparseVector,
        limit: number,
    ): Promise<{ svId: string; similarity: number }[]> {
        const CHUNK_SIZE = 500;
        const scores: { svId: string; similarity: number }[] = [];

        for (let i = 0; i < candidateSvIds.length; i += CHUNK_SIZE) {
            const chunk = candidateSvIds.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');

            // Join with symbols to get kind for relevance boosting
            const result = await db.query(`
                SELECT sev.symbol_version_id, sev.sparse_vector, s.kind,
                       sv.range_end_line - sv.range_start_line + 1 as line_span
                FROM semantic_vectors sev
                JOIN symbol_versions sv ON sv.symbol_version_id = sev.symbol_version_id
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                WHERE sev.symbol_version_id IN (${placeholders})
                AND sev.view_type = 'body'
            `, chunk);

            for (const row of result.rows) {
                let svVec: SparseVector;
                try {
                    svVec = typeof row.sparse_vector === 'string'
                        ? JSON.parse(row.sparse_vector)
                        : row.sparse_vector;
                } catch (error) {
                    log.debug('Skipping corrupt body vector during chunked scan', {
                        candidate_count: candidateSvIds.length,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }

                let sim = cosineSimilarity(queryVector, svVec);

                // Kind-based relevance boosting: meaningful code units rank higher
                const kind = row.kind as string;
                const lineSpan = typeof row.line_span === 'number' ? row.line_span : 0;
                if (kind === 'function' || kind === 'method' || kind === 'class') {
                    sim *= 1.15;
                } else if (kind === 'interface') {
                    sim *= 0.9;
                } else if ((kind === 'variable' || kind === 'constant') && lineSpan <= 2) {
                    sim *= 0.2; // Single-line declarations are noise
                }

                if (sim > 0.01) {
                    scores.push({ svId: row.symbol_version_id as string, similarity: Math.min(1.0, sim) });
                }
            }
        }

        scores.sort((a, b) => b.similarity - a.similarity);
        return scores.slice(0, limit);
    }

    /**
     * Batched fallback: scan ALL body vectors in the snapshot using keyset
     * (cursor-based) pagination in batches of 500, computing cosine similarity
     * per batch and keeping only the top-k results. Never holds more than
     * 500 vectors in memory at once.
     *
     * Uses keyset pagination (WHERE id > $lastSeen) instead of LIMIT/OFFSET
     * for stable performance regardless of how deep into the result set we are.
     */
    private async _batchedVectorScan(
        snapshotId: string,
        queryVector: SparseVector,
        limit: number,
    ): Promise<{ svId: string; similarity: number }[]> {
        const BATCH_SIZE = 500;
        let lastSeenId: string | null = null;
        let topScores: { svId: string; similarity: number }[] = [];
        let hasMore = true;

        while (hasMore) {
            // Join with symbols for kind-based relevance boosting
            const result = lastSeenId === null
                ? await db.query(`
                    SELECT sv2.symbol_version_id, sv2.sparse_vector, s.kind,
                           symv.range_end_line - symv.range_start_line + 1 as line_span
                    FROM semantic_vectors sv2
                    JOIN symbol_versions symv ON symv.symbol_version_id = sv2.symbol_version_id
                    JOIN symbols s ON s.symbol_id = symv.symbol_id
                    WHERE symv.snapshot_id = $1 AND sv2.view_type = 'body'
                    ORDER BY sv2.symbol_version_id
                    LIMIT $2
                `, [snapshotId, BATCH_SIZE])
                : await db.query(`
                    SELECT sv2.symbol_version_id, sv2.sparse_vector, s.kind,
                           symv.range_end_line - symv.range_start_line + 1 as line_span
                    FROM semantic_vectors sv2
                    JOIN symbol_versions symv ON symv.symbol_version_id = sv2.symbol_version_id
                    JOIN symbols s ON s.symbol_id = symv.symbol_id
                    WHERE symv.snapshot_id = $1 AND sv2.view_type = 'body'
                      AND sv2.symbol_version_id > $3
                    ORDER BY sv2.symbol_version_id
                    LIMIT $2
                `, [snapshotId, BATCH_SIZE, lastSeenId]);

            if (result.rows.length === 0) break;

            for (const row of result.rows) {
                let svVec: SparseVector;
                try {
                    svVec = typeof row.sparse_vector === 'string'
                        ? JSON.parse(row.sparse_vector)
                        : row.sparse_vector;
                } catch (error) {
                    log.debug('Skipping corrupt body vector during batched scan', {
                        snapshotId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }

                let sim = cosineSimilarity(queryVector, svVec);

                // Kind-based relevance boosting (same as _scoreCandidatesByVector)
                const kind = row.kind as string;
                const lineSpan = typeof row.line_span === 'number' ? row.line_span : 0;
                if (kind === 'function' || kind === 'method' || kind === 'class') {
                    sim *= 1.15;
                } else if (kind === 'interface') {
                    sim *= 0.9;
                } else if ((kind === 'variable' || kind === 'constant') && lineSpan <= 2) {
                    sim *= 0.2;
                }

                if (sim > 0.01) {
                    topScores.push({ svId: row.symbol_version_id as string, similarity: Math.min(1.0, sim) });
                }
            }

            // Track the last seen ID for keyset cursor
            lastSeenId = result.rows[result.rows.length - 1].symbol_version_id as string;

            // After each batch, trim to top-k to keep memory bounded
            if (topScores.length > limit * 2) {
                topScores.sort((a, b) => b.similarity - a.similarity);
                topScores = topScores.slice(0, limit);
            }

            // If we got fewer rows than BATCH_SIZE, we've reached the end
            hasMore = result.rows.length >= BATCH_SIZE;
        }

        topScores.sort((a, b) => b.similarity - a.similarity);
        return topScores.slice(0, limit);
    }
}

export const semanticEngine = new SemanticEngine();
