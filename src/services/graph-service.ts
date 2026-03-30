/**
 * ContextZero — Graph Service
 *
 * Shared business logic for graph traversal, relation explanation,
 * test artifact discovery, concept-based search, and homolog review.
 * Used by both the REST API (mcp-interface) and MCP bridge (mcp-bridge/handlers).
 */

import { db } from '../db-driver';
import { firstRow } from '../db-driver/result';
import { UserFacingError, classifyConfidenceBand } from '../types';
import { Logger } from '../logger';

const log = new Logger('graph-service');

// ────────── Constants ──────────

const PG_PARAM_CHUNK_SIZE = 500;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;
const DEFAULT_MAX_NODES = 100;
const DEFAULT_CONCEPT_LIMIT = 20;

// ════════════════════════════════════════════════════════════════════════════
// 1. getNeighbors — BFS graph traversal
// ════════════════════════════════════════════════════════════════════════════

export interface GetNeighborsOptions {
    symbol_version_id: string;
    snapshot_id: string;
    relation_types?: string[];
    direction?: 'inbound' | 'outbound' | 'both';
    depth?: number;
    max_nodes?: number;
}

export interface NeighborhoodNode {
    symbol_version_id: string;
    symbol_id: string;
    canonical_name: string;
    kind: string;
    file_path: string;
    start_line: number;
    depth: number;
}

export interface NeighborhoodEdge {
    source_id: string;
    target_id: string;
    relation_type: string;
    confidence: number;
    strength: number;
}

export interface NeighborhoodResult {
    origin: string;
    nodes: NeighborhoodNode[];
    edges: NeighborhoodEdge[];
    truncated: boolean;
    depth_reached: number;
}

/**
 * BFS graph traversal from a symbol_version_id, collecting neighboring
 * symbols via structural_relations up to the configured depth.
 */
export async function getNeighbors(
    options: GetNeighborsOptions,
): Promise<NeighborhoodResult> {
    const {
        symbol_version_id,
        snapshot_id,
        relation_types,
        direction = 'both',
        depth: rawDepth = DEFAULT_DEPTH,
        max_nodes: maxNodes = DEFAULT_MAX_NODES,
    } = options;

    const depth = Math.min(Math.max(rawDepth, 1), MAX_DEPTH);

    const nodes: NeighborhoodNode[] = [];
    const edges: NeighborhoodEdge[] = [];
    const visitedIds = new Set<string>([symbol_version_id]);
    let frontier = [symbol_version_id];
    let depthReached = 0;
    let truncated = false;

    // Load origin node metadata
    const originResult = await db.query(`
        SELECT sv.symbol_version_id, sv.symbol_id, s.canonical_name, s.kind,
               f.path as file_path, sv.range_start_line
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id = $1
    `, [symbol_version_id]);

    if (originResult.rows.length === 0) {
        throw UserFacingError.notFound('Symbol version');
    }

    const originRow = originResult.rows[0] as Record<string, unknown>;
    nodes.push({
        symbol_version_id,
        symbol_id: (originRow.symbol_id as string) ?? '',
        canonical_name: (originRow.canonical_name as string) ?? '',
        kind: (originRow.kind as string) ?? 'unknown',
        file_path: (originRow.file_path as string) ?? '',
        start_line: typeof originRow.range_start_line === 'number' ? originRow.range_start_line : 0,
        depth: 0,
    });

    // BFS loop
    for (let currentDepth = 1; currentDepth <= depth; currentDepth++) {
        if (frontier.length === 0 || nodes.length >= maxNodes) {
            if (nodes.length >= maxNodes) truncated = true;
            break;
        }

        const newFrontier: string[] = [];

        // Process frontier in chunks to respect PostgreSQL parameter limits
        for (let offset = 0; offset < frontier.length; offset += PG_PARAM_CHUNK_SIZE) {
            if (nodes.length >= maxNodes) {
                truncated = true;
                break;
            }

            const chunk = frontier.slice(offset, offset + PG_PARAM_CHUNK_SIZE);

            // Build parameterized IN-list starting at $2 (snapshot_id is $1)
            const placeholders = chunk.map((_, i) => `$${i + 2}`).join(',');
            const baseParams: unknown[] = [snapshot_id, ...chunk];
            let paramIdx = chunk.length + 2;

            // Build direction-dependent WHERE clause
            let directionClause: string;
            if (direction === 'outbound') {
                directionClause = `sr.src_symbol_version_id IN (${placeholders})`;
            } else if (direction === 'inbound') {
                directionClause = `sr.dst_symbol_version_id IN (${placeholders})`;
            } else {
                directionClause = `(sr.src_symbol_version_id IN (${placeholders}) OR sr.dst_symbol_version_id IN (${placeholders}))`;
            }

            // Optional relation_types filter
            let typeFilter = '';
            if (relation_types && relation_types.length > 0) {
                const typePH = relation_types.map((_, i) => `$${paramIdx + i}`).join(',');
                typeFilter = ` AND sr.relation_type IN (${typePH})`;
                baseParams.push(...relation_types);
                paramIdx += relation_types.length;
            }

            const sql = `
                SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id,
                       sr.relation_type, sr.confidence, sr.strength,
                       sv.symbol_version_id as neighbor_svid, sv.symbol_id,
                       s.canonical_name, s.kind,
                       f.path as file_path, sv.range_start_line
                FROM structural_relations sr
                JOIN symbol_versions sv_src ON sv_src.symbol_version_id = sr.src_symbol_version_id
                JOIN symbol_versions sv_dst ON sv_dst.symbol_version_id = sr.dst_symbol_version_id
                JOIN symbol_versions sv ON sv.symbol_version_id = CASE
                    WHEN sr.src_symbol_version_id IN (${placeholders}) THEN sr.dst_symbol_version_id
                    ELSE sr.src_symbol_version_id
                END
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE ${directionClause}
                  AND (sv_src.snapshot_id = $1 OR sv_dst.snapshot_id = $1)
                  ${typeFilter}
            `;

            const result = await db.query(sql, baseParams);

            for (const row of result.rows as Record<string, unknown>[]) {
                const neighborSvid = (row.neighbor_svid as string) ?? '';

                // Record the edge
                edges.push({
                    source_id: (row.src_symbol_version_id as string) ?? '',
                    target_id: (row.dst_symbol_version_id as string) ?? '',
                    relation_type: (row.relation_type as string) ?? '',
                    confidence: typeof row.confidence === 'number' ? row.confidence : 1.0,
                    strength: typeof row.strength === 'number' ? row.strength : 1.0,
                });

                // Track new nodes
                if (!visitedIds.has(neighborSvid)) {
                    visitedIds.add(neighborSvid);

                    if (nodes.length >= maxNodes) {
                        truncated = true;
                        break;
                    }

                    nodes.push({
                        symbol_version_id: neighborSvid,
                        symbol_id: (row.symbol_id as string) ?? '',
                        canonical_name: (row.canonical_name as string) ?? '',
                        kind: (row.kind as string) ?? 'unknown',
                        file_path: (row.file_path as string) ?? '',
                        start_line: typeof row.range_start_line === 'number' ? row.range_start_line : 0,
                        depth: currentDepth,
                    });

                    newFrontier.push(neighborSvid);
                }
            }
        }

        depthReached = currentDepth;
        frontier = newFrontier;
    }

    log.info('BFS traversal complete', {
        origin: symbol_version_id,
        nodes_found: nodes.length,
        edges_found: edges.length,
        depth_reached: depthReached,
        truncated,
    });

    return {
        origin: symbol_version_id,
        nodes,
        edges,
        truncated,
        depth_reached: depthReached,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. explainRelation — Find and explain all relations between two symbols
// ════════════════════════════════════════════════════════════════════════════

export interface ExplainRelationOptions {
    src_symbol_version_id: string;
    dst_symbol_version_id: string;
    snapshot_id: string;
}

export interface RelationExplanation {
    structural_relations: {
        relation_type: string;
        strength: number;
        confidence: number;
        provenance: string | null;
    }[];
    inferred_relations: {
        relation_type: string;
        confidence: number;
        review_state: string;
        evidence: {
            semantic_score: number;
            structural_score: number;
            behavioral_score: number;
            contract_score: number;
            test_score: number;
            history_score: number;
            contradiction_flags: string[];
        } | null;
    }[];
    summary: string;
}

/**
 * Explain all relations (structural and inferred) between two symbol versions.
 * Returns detailed evidence for each relation found.
 */
export async function explainRelation(
    options: ExplainRelationOptions,
): Promise<RelationExplanation> {
    const { src_symbol_version_id, dst_symbol_version_id, snapshot_id } = options;

    // Query structural relations in both directions
    const structuralResult = await db.query(`
        SELECT sr.relation_type, sr.strength, sr.confidence, sr.provenance
        FROM structural_relations sr
        JOIN symbol_versions sv_src ON sv_src.symbol_version_id = sr.src_symbol_version_id
        JOIN symbol_versions sv_dst ON sv_dst.symbol_version_id = sr.dst_symbol_version_id
        WHERE ((sr.src_symbol_version_id = $1 AND sr.dst_symbol_version_id = $2)
            OR (sr.src_symbol_version_id = $2 AND sr.dst_symbol_version_id = $1))
          AND (sv_src.snapshot_id = $3 OR sv_dst.snapshot_id = $3)
    `, [src_symbol_version_id, dst_symbol_version_id, snapshot_id]);

    const structural_relations = (structuralResult.rows as Record<string, unknown>[]).map(row => ({
        relation_type: (row.relation_type as string) ?? '',
        strength: typeof row.strength === 'number' ? row.strength : 1.0,
        confidence: typeof row.confidence === 'number' ? row.confidence : 1.0,
        provenance: typeof row.provenance === 'string' ? row.provenance : null,
    }));

    // Query inferred relations with evidence bundles in both directions
    const inferredResult = await db.query(`
        SELECT ir.relation_type, ir.confidence, ir.review_state,
               eb.semantic_score, eb.structural_score, eb.behavioral_score,
               eb.contract_score, eb.test_score, eb.history_score,
               eb.contradiction_flags
        FROM inferred_relations ir
        LEFT JOIN evidence_bundles eb ON eb.inferred_relation_id = ir.inferred_relation_id
        WHERE (ir.src_symbol_version_id = $1 AND ir.dst_symbol_version_id = $2)
           OR (ir.src_symbol_version_id = $2 AND ir.dst_symbol_version_id = $1)
    `, [src_symbol_version_id, dst_symbol_version_id]);

    const inferred_relations = (inferredResult.rows as Record<string, unknown>[]).map(row => {
        const hasEvidence = typeof row.semantic_score === 'number';
        return {
            relation_type: (row.relation_type as string) ?? '',
            confidence: typeof row.confidence === 'number' ? row.confidence : 0,
            review_state: (row.review_state as string) ?? 'pending',
            evidence: hasEvidence ? {
                semantic_score: typeof row.semantic_score === 'number' ? row.semantic_score : 0,
                structural_score: typeof row.structural_score === 'number' ? row.structural_score : 0,
                behavioral_score: typeof row.behavioral_score === 'number' ? row.behavioral_score : 0,
                contract_score: typeof row.contract_score === 'number' ? row.contract_score : 0,
                test_score: typeof row.test_score === 'number' ? row.test_score : 0,
                history_score: typeof row.history_score === 'number' ? row.history_score : 0,
                contradiction_flags: Array.isArray(row.contradiction_flags)
                    ? (row.contradiction_flags as unknown[]).filter((v): v is string => typeof v === 'string')
                    : [],
            } : null,
        };
    });

    // Build human-readable summary
    const parts: string[] = [];
    if (structural_relations.length > 0) {
        const types = structural_relations.map(r => r.relation_type).join(', ');
        parts.push(`${structural_relations.length} structural relation(s): ${types}`);
    }
    if (inferred_relations.length > 0) {
        const types = inferred_relations.map(r => `${r.relation_type} (${classifyConfidenceBand(r.confidence)})`).join(', ');
        parts.push(`${inferred_relations.length} inferred relation(s): ${types}`);
    }
    if (parts.length === 0) {
        parts.push('No direct relations found between these symbols.');
    }
    const summary = parts.join('. ');

    log.info('Relation explanation computed', {
        src: src_symbol_version_id,
        dst: dst_symbol_version_id,
        structural_count: structural_relations.length,
        inferred_count: inferred_relations.length,
    });

    return { structural_relations, inferred_relations, summary };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. getTests — Retrieve test artifacts related to a symbol
// ════════════════════════════════════════════════════════════════════════════

export interface GetTestsOptions {
    symbol_id: string;
    snapshot_id: string;
}

export interface TestInfo {
    test_artifact_id: string;
    test_symbol_version_id: string;
    test_name: string;
    framework: string;
    assertion_summary: string;
    coverage_hints: string[];
    file_path: string;
    start_line: number;
}

export interface TestsResult {
    symbol_id: string;
    tests: TestInfo[];
    test_count: number;
    frameworks: string[];
}

/**
 * Retrieve all test artifacts related to a symbol within a snapshot.
 * Searches via the related_symbols array on test_artifacts and also checks
 * structural_relations for test-to-symbol links.
 */
export async function getTests(
    options: GetTestsOptions,
): Promise<TestsResult> {
    const { symbol_id, snapshot_id } = options;

    // Step 1: Find all symbol_versions for this symbol_id in the snapshot
    const svResult = await db.query(`
        SELECT sv.symbol_version_id
        FROM symbol_versions sv
        WHERE sv.symbol_id = $1 AND sv.snapshot_id = $2
    `, [symbol_id, snapshot_id]);

    const svIds = (svResult.rows as Record<string, unknown>[])
        .map(r => (r.symbol_version_id as string) ?? '')
        .filter(id => id.length > 0);

    if (svIds.length === 0) {
        return { symbol_id, tests: [], test_count: 0, frameworks: [] };
    }

    const testMap = new Map<string, TestInfo>();

    // Step 2: Query test_artifacts where related_symbols contains any of these svIds
    // Process in chunks to respect parameter limits
    for (let offset = 0; offset < svIds.length; offset += PG_PARAM_CHUNK_SIZE) {
        const chunk = svIds.slice(offset, offset + PG_PARAM_CHUNK_SIZE);
        const placeholders = chunk.map((_, i) => `$${i + 2}`).join(',');

        const taResult = await db.query(`
            SELECT ta.test_artifact_id, ta.symbol_version_id as test_symbol_version_id,
                   s.canonical_name as test_name, ta.framework,
                   ta.assertion_summary, ta.coverage_hints,
                   f.path as file_path, sv.range_start_line
            FROM test_artifacts ta
            JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
              AND ta.related_symbols && ARRAY[${placeholders}]::text[]
        `, [snapshot_id, ...chunk]);

        for (const row of taResult.rows as Record<string, unknown>[]) {
            const artifactId = (row.test_artifact_id as string) ?? '';
            if (artifactId && !testMap.has(artifactId)) {
                testMap.set(artifactId, {
                    test_artifact_id: artifactId,
                    test_symbol_version_id: (row.test_symbol_version_id as string) ?? '',
                    test_name: (row.test_name as string) ?? '',
                    framework: (row.framework as string) ?? '',
                    assertion_summary: (row.assertion_summary as string) ?? '',
                    coverage_hints: Array.isArray(row.coverage_hints)
                        ? (row.coverage_hints as unknown[]).filter((v): v is string => typeof v === 'string')
                        : [],
                    file_path: (row.file_path as string) ?? '',
                    start_line: typeof row.range_start_line === 'number' ? row.range_start_line : 0,
                });
            }
        }
    }

    // Step 3: Check structural_relations for test-to-symbol links
    // (relation_type = 'references' where source is a test_case)
    for (let offset = 0; offset < svIds.length; offset += PG_PARAM_CHUNK_SIZE) {
        const chunk = svIds.slice(offset, offset + PG_PARAM_CHUNK_SIZE);
        const placeholders = chunk.map((_, i) => `$${i + 2}`).join(',');

        const relResult = await db.query(`
            SELECT DISTINCT ta.test_artifact_id,
                   sr.src_symbol_version_id as test_symbol_version_id,
                   s.canonical_name as test_name, ta.framework,
                   ta.assertion_summary, ta.coverage_hints,
                   f.path as file_path, sv_src.range_start_line
            FROM structural_relations sr
            JOIN symbol_versions sv_src ON sv_src.symbol_version_id = sr.src_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv_src.symbol_id
            JOIN files f ON f.file_id = sv_src.file_id
            JOIN test_artifacts ta ON ta.symbol_version_id = sr.src_symbol_version_id
            WHERE sr.dst_symbol_version_id IN (${placeholders})
              AND sr.relation_type = 'references'
              AND s.kind = 'test_case'
              AND sv_src.snapshot_id = $1
        `, [snapshot_id, ...chunk]);

        for (const row of relResult.rows as Record<string, unknown>[]) {
            const artifactId = (row.test_artifact_id as string) ?? '';
            if (artifactId && !testMap.has(artifactId)) {
                testMap.set(artifactId, {
                    test_artifact_id: artifactId,
                    test_symbol_version_id: (row.test_symbol_version_id as string) ?? '',
                    test_name: (row.test_name as string) ?? '',
                    framework: (row.framework as string) ?? '',
                    assertion_summary: (row.assertion_summary as string) ?? '',
                    coverage_hints: Array.isArray(row.coverage_hints)
                        ? (row.coverage_hints as unknown[]).filter((v): v is string => typeof v === 'string')
                        : [],
                    file_path: (row.file_path as string) ?? '',
                    start_line: typeof row.range_start_line === 'number' ? row.range_start_line : 0,
                });
            }
        }
    }

    const tests = Array.from(testMap.values());
    const frameworkSet = new Set(tests.map(t => t.framework).filter(f => f.length > 0));

    log.info('Tests retrieved for symbol', {
        symbol_id,
        test_count: tests.length,
        frameworks: Array.from(frameworkSet),
    });

    return {
        symbol_id,
        tests,
        test_count: tests.length,
        frameworks: Array.from(frameworkSet),
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. findConcept — Concept-based discovery via trigram + family + contract search
// ════════════════════════════════════════════════════════════════════════════

export interface FindConceptOptions {
    concept: string;
    repo_id: string;
    snapshot_id: string;
    kind_filter?: string;
    language_filter?: string;
    limit?: number;
}

export interface ConceptMatch {
    symbol_version_id: string;
    symbol_id: string;
    canonical_name: string;
    kind: string;
    file_path: string;
    start_line: number;
    relevance: number;
    match_source: 'name' | 'semantic' | 'concept_family' | 'contract';
    family_name: string | null;
    family_type: string | null;
}

export interface ConceptResult {
    concept: string;
    matches: ConceptMatch[];
    total_found: number;
}

/**
 * Search for symbols matching a concept string using multiple strategies:
 * trigram name similarity, concept family matching, and contract text search.
 * Results are merged, deduplicated, and ranked by relevance.
 */
export async function findConcept(
    options: FindConceptOptions,
): Promise<ConceptResult> {
    const {
        concept,
        repo_id,
        snapshot_id,
        kind_filter,
        language_filter,
        limit = DEFAULT_CONCEPT_LIMIT,
    } = options;

    const matchMap = new Map<string, ConceptMatch>();

    // Strategy 1: Trigram similarity on canonical_name (pg_trgm)
    {
        let sql = `
            SELECT sv.symbol_version_id, s.symbol_id, s.canonical_name, s.kind,
                   f.path as file_path, sv.range_start_line,
                   similarity(s.canonical_name, $1) as relevance
            FROM symbols s
            JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE s.repo_id = $2
              AND sv.snapshot_id = $3
              AND (s.canonical_name % $1 OR s.canonical_name ILIKE '%' || $1 || '%')
        `;
        const params: unknown[] = [concept, repo_id, snapshot_id];
        let paramIdx = 4;

        if (kind_filter) {
            sql += ` AND s.kind = $${paramIdx}`;
            params.push(kind_filter);
            paramIdx++;
        }
        if (language_filter) {
            sql += ` AND sv.language = $${paramIdx}`;
            params.push(language_filter);
            paramIdx++;
        }

        sql += ` ORDER BY relevance DESC LIMIT $${paramIdx}`;
        params.push(limit);

        const nameResult = await db.query(sql, params);

        for (const row of nameResult.rows as Record<string, unknown>[]) {
            const svid = (row.symbol_version_id as string) ?? '';
            if (svid && !matchMap.has(svid)) {
                matchMap.set(svid, {
                    symbol_version_id: svid,
                    symbol_id: (row.symbol_id as string) ?? '',
                    canonical_name: (row.canonical_name as string) ?? '',
                    kind: (row.kind as string) ?? 'unknown',
                    file_path: (row.file_path as string) ?? '',
                    start_line: typeof row.range_start_line === 'number' ? row.range_start_line : 0,
                    relevance: typeof row.relevance === 'number' ? row.relevance : 0,
                    match_source: 'name',
                    family_name: null,
                    family_type: null,
                });
            }
        }
    }

    // Strategy 2: Concept family name similarity
    {
        let sql = `
            SELECT cfm.symbol_version_id, sv.symbol_id, s.canonical_name, s.kind,
                   f.path as file_path, sv.range_start_line,
                   similarity(cf.family_name, $1) as relevance,
                   cf.family_name, cf.family_type
            FROM concept_families cf
            JOIN concept_family_members cfm ON cfm.family_id = cf.family_id
            JOIN symbol_versions sv ON sv.symbol_version_id = cfm.symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE cf.repo_id = $2
              AND cf.snapshot_id = $3
              AND (cf.family_name % $1 OR cf.family_name ILIKE '%' || $1 || '%')
        `;
        const params: unknown[] = [concept, repo_id, snapshot_id];
        let paramIdx = 4;

        if (kind_filter) {
            sql += ` AND s.kind = $${paramIdx}`;
            params.push(kind_filter);
            paramIdx++;
        }
        if (language_filter) {
            sql += ` AND sv.language = $${paramIdx}`;
            params.push(language_filter);
            paramIdx++;
        }

        sql += ` ORDER BY relevance DESC LIMIT $${paramIdx}`;
        params.push(limit);

        const familyResult = await db.query(sql, params);

        for (const row of familyResult.rows as Record<string, unknown>[]) {
            const svid = (row.symbol_version_id as string) ?? '';
            if (svid && !matchMap.has(svid)) {
                matchMap.set(svid, {
                    symbol_version_id: svid,
                    symbol_id: (row.symbol_id as string) ?? '',
                    canonical_name: (row.canonical_name as string) ?? '',
                    kind: (row.kind as string) ?? 'unknown',
                    file_path: (row.file_path as string) ?? '',
                    start_line: typeof row.range_start_line === 'number' ? row.range_start_line : 0,
                    relevance: typeof row.relevance === 'number' ? row.relevance * 0.9 : 0,
                    match_source: 'concept_family',
                    family_name: typeof row.family_name === 'string' ? row.family_name : null,
                    family_type: typeof row.family_type === 'string' ? row.family_type : null,
                });
            }
        }
    }

    // Strategy 3: Contract text search (input/output/error contracts)
    {
        let sql = `
            SELECT sv.symbol_version_id, s.symbol_id, s.canonical_name, s.kind,
                   f.path as file_path, sv.range_start_line,
                   0.7 as relevance
            FROM contract_profiles cp
            JOIN symbol_versions sv ON sv.symbol_version_id = cp.symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $2
              AND s.repo_id = $3
              AND (cp.input_contract ILIKE '%' || $1 || '%'
                   OR cp.output_contract ILIKE '%' || $1 || '%'
                   OR cp.error_contract ILIKE '%' || $1 || '%')
        `;
        const params: unknown[] = [concept, snapshot_id, repo_id];
        let paramIdx = 4;

        if (kind_filter) {
            sql += ` AND s.kind = $${paramIdx}`;
            params.push(kind_filter);
            paramIdx++;
        }
        if (language_filter) {
            sql += ` AND sv.language = $${paramIdx}`;
            params.push(language_filter);
            paramIdx++;
        }

        sql += ` LIMIT $${paramIdx}`;
        params.push(limit);

        const contractResult = await db.query(sql, params);

        for (const row of contractResult.rows as Record<string, unknown>[]) {
            const svid = (row.symbol_version_id as string) ?? '';
            if (svid && !matchMap.has(svid)) {
                matchMap.set(svid, {
                    symbol_version_id: svid,
                    symbol_id: (row.symbol_id as string) ?? '',
                    canonical_name: (row.canonical_name as string) ?? '',
                    kind: (row.kind as string) ?? 'unknown',
                    file_path: (row.file_path as string) ?? '',
                    start_line: typeof row.range_start_line === 'number' ? row.range_start_line : 0,
                    relevance: typeof row.relevance === 'number' ? row.relevance : 0.7,
                    match_source: 'contract',
                    family_name: null,
                    family_type: null,
                });
            }
        }
    }

    // Merge, sort by relevance descending, and apply final limit
    const matches = Array.from(matchMap.values())
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, limit);

    log.info('Concept search complete', {
        concept,
        total_found: matchMap.size,
        returned: matches.length,
    });

    return {
        concept,
        matches,
        total_found: matchMap.size,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. reviewHomolog — Update review_state of inferred relations
// ════════════════════════════════════════════════════════════════════════════

export interface ReviewHomologOptions {
    inferred_relation_id: string;
    review_state: 'confirmed' | 'rejected' | 'flagged';
    reviewer?: string;
}

export interface ReviewResult {
    inferred_relation_id: string;
    previous_state: string;
    new_state: string;
    updated: boolean;
}

/**
 * Update the review_state of an inferred relation.
 * Returns the previous and new state for audit purposes.
 */
export async function reviewHomolog(
    options: ReviewHomologOptions,
): Promise<ReviewResult> {
    const { inferred_relation_id, review_state, reviewer } = options;

    // Step 1: Fetch current state
    const currentResult = await db.query(`
        SELECT review_state
        FROM inferred_relations
        WHERE inferred_relation_id = $1
    `, [inferred_relation_id]);

    const currentRow = firstRow(currentResult);
    if (!currentRow) {
        throw UserFacingError.notFound('Inferred relation');
    }

    const previousState = typeof currentRow.review_state === 'string'
        ? currentRow.review_state
        : 'pending';

    // Step 2: Update review_state
    const updateResult = await db.query(`
        UPDATE inferred_relations
        SET review_state = $2, updated_at = NOW()
        WHERE inferred_relation_id = $1
    `, [inferred_relation_id, review_state]);

    const updated = (updateResult.rowCount ?? 0) > 0;

    log.info('Homolog review state updated', {
        inferred_relation_id,
        previous_state: previousState,
        new_state: review_state,
        reviewer: reviewer ?? 'unknown',
        updated,
    });

    return {
        inferred_relation_id,
        previous_state: previousState,
        new_state: review_state,
        updated,
    };
}
