/**
 * ContextZero — Concept Family Engine
 *
 * Turns pairwise homolog detection into operational concept families.
 * Instead of just "A is similar to B", it builds family clusters:
 * "A, B, C, D are all email validators with a shared contract."
 *
 * Pipeline:
 *   1. Candidate generation — load inferred_relations (homolog pairs)
 *   2. Graph clustering — connected components with modularity bisection
 *   3. Family type classification — majority vote on member properties
 *   4. Exemplar selection — highest avg similarity, most complete profile
 *   5. Family fingerprinting — intersection contracts, union effects
 *   6. Outlier & contradiction detection — similarity + behavioral/contract checks
 *
 * Database tables: concept_families, concept_family_members
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { BatchLoader } from '../db-driver/batch-loader';
import { Logger } from '../logger';
import type { BehavioralProfile, ContractProfile } from '../types';

const log = new Logger('concept-families');

// ────────── Types ──────────

export interface ConceptFamily {
    family_id: string;
    repo_id: string;
    snapshot_id: string;
    family_name: string;
    family_type: string;
    exemplar_symbol_version_id: string | null;
    family_contract_fingerprint: string | null;
    family_effect_fingerprint: string | null;
    member_count: number;
    avg_confidence: number;
    contradiction_count: number;
    created_at: Date;
}

export interface ConceptFamilyMember {
    member_id: string;
    family_id: string;
    symbol_version_id: string;
    is_exemplar: boolean;
    is_outlier: boolean;
    is_contradicting: boolean;
    similarity_to_exemplar: number;
    membership_confidence: number;
    contradiction_flags: string[];
    contract_deviation: string | null;
    effect_deviation: string | null;
}

export interface FamilyBuildResult {
    families_created: number;
    total_members: number;
    total_outliers: number;
    total_contradictions: number;
    duration_ms: number;
}

export interface RawCluster {
    member_sv_ids: string[];
    internal_edges: EdgeRecord[];
    avg_confidence: number;
}

export interface MemberData {
    symbol_version_id: string;
    canonical_name: string;
    kind: string;
    stable_key: string;
}

export interface OutlierResult {
    symbol_version_id: string;
    is_outlier: boolean;
    is_contradicting: boolean;
    similarity_to_exemplar: number;
    contradiction_flags: string[];
    contract_deviation: string | null;
    effect_deviation: string | null;
}

interface EdgeRecord {
    src: string;
    dst: string;
    confidence: number;
    relation_type: string;
}

interface AdjacencyData {
    confidence: number;
    relation_type: string;
}

// ────────── Constants ──────────

/** Minimum confidence on an inferred relation to include it in the similarity graph */
const MIN_EDGE_CONFIDENCE = 0.40;

/** Fallback threshold for retrying clustering when primary yields nothing */
const FALLBACK_EDGE_CONFIDENCE = 0.25;

/** Minimum cluster size to consider for concept family creation */
const MIN_FAMILY_SIZE = 2;

/** Maximum cluster size before attempting modularity bisection */
const MAX_CLUSTER_SIZE_BEFORE_SPLIT = 50;

/** Minimum internal density (avg similarity) for a cluster to be valid without splitting */
const MIN_INTERNAL_DENSITY = 0.40;

/** Outlier threshold factor — member is outlier if sim < factor * avg_family_sim */
const OUTLIER_THRESHOLD_FACTOR = 0.5;

// ────────── Engine ──────────

export class ConceptFamilyEngine {

    /**
     * Build all concept families for a snapshot.
     * Orchestrates the full pipeline: cluster -> classify -> exemplar -> fingerprint -> outliers.
     */
    public async buildFamilies(repoId: string, snapshotId: string): Promise<FamilyBuildResult> {
        const timer = log.startTimer('buildFamilies', { repoId, snapshotId });
        const startMs = Date.now();

        // Step 0: Clear any existing families for this snapshot.
        // Wrapped in a transaction to prevent concurrent readers from seeing
        // an intermediate state where families exist but members don't.
        await db.transaction(async (client) => {
            await db.queryWithClient(client,
                `DELETE FROM concept_family_members WHERE family_id IN
                    (SELECT family_id FROM concept_families WHERE repo_id = $1 AND snapshot_id = $2)`,
                [repoId, snapshotId]
            );
            await db.queryWithClient(client,
                `DELETE FROM concept_families WHERE repo_id = $1 AND snapshot_id = $2`,
                [repoId, snapshotId]
            );
        });

        // Step 1: Cluster homolog pairs — retry at lower threshold if needed
        let rawClusters = await this.clusterHomologs(snapshotId, MIN_EDGE_CONFIDENCE);
        if (rawClusters.length === 0) {
            log.info('No clusters at primary threshold, retrying at fallback', {
                primary: MIN_EDGE_CONFIDENCE, fallback: FALLBACK_EDGE_CONFIDENCE,
            });
            rawClusters = await this.clusterHomologs(snapshotId, FALLBACK_EDGE_CONFIDENCE);
        }
        log.info('Clustering complete', { cluster_count: rawClusters.length, snapshotId });

        // Step 1b: Structural fallback — seed families from naming patterns
        // when homolog edges are sparse (small repos).
        if (rawClusters.length <= 1) {
            const structuralClusters = await this.clusterByNamingPatterns(snapshotId);
            if (structuralClusters.length > 0) {
                rawClusters.push(...structuralClusters);
                log.info('Structural naming pattern clusters added', {
                    structural_count: structuralClusters.length,
                });
            }
        }

        if (rawClusters.length === 0) {
            const result: FamilyBuildResult = {
                families_created: 0, total_members: 0,
                total_outliers: 0, total_contradictions: 0,
                duration_ms: Date.now() - startMs,
            };
            timer({ ...result });
            return result;
        }

        // Pre-load all symbol metadata for all cluster members
        const allSvIds = new Set<string>();
        for (const cluster of rawClusters) {
            for (const svId of cluster.member_sv_ids) {
                allSvIds.add(svId);
            }
        }
        const memberDataMap = await this.loadMemberData(Array.from(allSvIds));

        // Pre-load behavioral and contract profiles for all members
        const loader = new BatchLoader();
        const allSvArray = Array.from(allSvIds);
        const [behavioralMap, contractMap] = await Promise.all([
            loader.loadBehavioralProfiles(allSvArray),
            loader.loadContractProfiles(allSvArray),
        ]);

        let familiesCreated = 0;
        let totalMembers = 0;
        let totalOutliers = 0;
        let totalContradictions = 0;

        // Process each cluster into a concept family
        for (const cluster of rawClusters) {
            if (cluster.member_sv_ids.length < MIN_FAMILY_SIZE) continue;

            const memberData: MemberData[] = [];
            for (const svId of cluster.member_sv_ids) {
                const md = memberDataMap.get(svId);
                if (md) memberData.push(md);
            }
            if (memberData.length < MIN_FAMILY_SIZE) continue;

            const activeSvIds = memberData.map(m => m.symbol_version_id);

            // Step 2: Classify family type
            const familyType = this.classifyFamilyType(activeSvIds, memberData, behavioralMap);

            // Step 3: Select exemplar
            const exemplarSvId = this.selectExemplarSync(
                activeSvIds, cluster.internal_edges, behavioralMap, contractMap
            );

            // Step 4: Compute family fingerprints
            const fingerprints = this.computeFingerprintsFromCache(activeSvIds, behavioralMap, contractMap);

            // Step 5: Generate family name
            const familyName = this.generateFamilyName(memberData, familyType);

            // Step 6: Detect outliers and contradictions
            const outlierResults = this.detectOutliersFromCache(
                activeSvIds, exemplarSvId, cluster.internal_edges, behavioralMap, contractMap
            );

            // Compute family-level stats
            const outlierCount = outlierResults.filter(o => o.is_outlier).length;
            const contradictionCount = outlierResults.filter(o => o.is_contradicting).length;

            // Persist family
            const familyId = uuidv4();
            await db.query(`
                INSERT INTO concept_families (
                    family_id, repo_id, snapshot_id, family_name, family_type,
                    exemplar_symbol_version_id, family_contract_fingerprint,
                    family_effect_fingerprint, member_count, avg_confidence,
                    contradiction_count
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (repo_id, snapshot_id, family_name)
                DO UPDATE SET
                    family_type = EXCLUDED.family_type,
                    exemplar_symbol_version_id = EXCLUDED.exemplar_symbol_version_id,
                    family_contract_fingerprint = EXCLUDED.family_contract_fingerprint,
                    family_effect_fingerprint = EXCLUDED.family_effect_fingerprint,
                    member_count = EXCLUDED.member_count,
                    avg_confidence = EXCLUDED.avg_confidence,
                    contradiction_count = EXCLUDED.contradiction_count
            `, [
                familyId, repoId, snapshotId, familyName, familyType,
                exemplarSvId, fingerprints.contract, fingerprints.effect,
                activeSvIds.length, cluster.avg_confidence, contradictionCount,
            ]);

            // Persist members
            const memberStatements: { text: string; params: unknown[] }[] = [];
            for (const svId of activeSvIds) {
                const outlierInfo = outlierResults.find(o => o.symbol_version_id === svId);
                memberStatements.push({
                    text: `INSERT INTO concept_family_members (
                        member_id, family_id, symbol_version_id,
                        is_exemplar, is_outlier, is_contradicting,
                        similarity_to_exemplar, membership_confidence,
                        contradiction_flags, contract_deviation, effect_deviation
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (family_id, symbol_version_id) DO UPDATE SET
                        is_exemplar = EXCLUDED.is_exemplar,
                        is_outlier = EXCLUDED.is_outlier,
                        is_contradicting = EXCLUDED.is_contradicting,
                        similarity_to_exemplar = EXCLUDED.similarity_to_exemplar,
                        membership_confidence = EXCLUDED.membership_confidence,
                        contradiction_flags = EXCLUDED.contradiction_flags,
                        contract_deviation = EXCLUDED.contract_deviation,
                        effect_deviation = EXCLUDED.effect_deviation`,
                    params: [
                        uuidv4(), familyId, svId,
                        svId === exemplarSvId,
                        outlierInfo?.is_outlier ?? false,
                        outlierInfo?.is_contradicting ?? false,
                        outlierInfo?.similarity_to_exemplar ?? 0.0,
                        this.computeMembershipConfidence(svId, cluster),
                        outlierInfo?.contradiction_flags ?? [],
                        outlierInfo?.contract_deviation ?? null,
                        outlierInfo?.effect_deviation ?? null,
                    ],
                });
            }

            if (memberStatements.length > 0) {
                await db.batchInsert(memberStatements);
            }

            familiesCreated++;
            totalMembers += activeSvIds.length;
            totalOutliers += outlierCount;
            totalContradictions += contradictionCount;
        }

        const result: FamilyBuildResult = {
            families_created: familiesCreated,
            total_members: totalMembers,
            total_outliers: totalOutliers,
            total_contradictions: totalContradictions,
            duration_ms: Date.now() - startMs,
        };

        timer({ ...result });
        return result;
    }

    // ────────── 1. Clustering ──────────

    /**
     * Cluster homolog pairs into families using connected components
     * with quality-based bisection for oversized/low-density components.
     */
    public async clusterHomologs(snapshotId: string, minConfidence: number = MIN_EDGE_CONFIDENCE): Promise<RawCluster[]> {
        const timer = log.startTimer('clusterHomologs', { snapshotId, minConfidence });

        // Load all inferred relations (homolog edges) for the snapshot
        const edgeResult = await db.query(`
            SELECT ir.src_symbol_version_id, ir.dst_symbol_version_id,
                   ir.confidence, ir.relation_type
            FROM inferred_relations ir
            JOIN symbol_versions sv_src ON sv_src.symbol_version_id = ir.src_symbol_version_id
            WHERE sv_src.snapshot_id = $1
            AND ir.confidence >= $2
            AND ir.review_state != 'rejected'
            AND ir.valid_to_snapshot_id IS NULL
            AND ir.relation_type != 'co_changed_with'
        `, [snapshotId, minConfidence]);

        const edges = edgeResult.rows as Array<{
            src_symbol_version_id: string;
            dst_symbol_version_id: string;
            confidence: number;
            relation_type: string;
        }>;

        if (edges.length === 0) {
            timer({ clusters: 0 });
            return [];
        }

        // Build adjacency graph (undirected)
        const adjacency = new Map<string, Map<string, AdjacencyData>>();
        const ensureNode = (id: string): Map<string, AdjacencyData> => {
            let neighbors = adjacency.get(id);
            if (!neighbors) {
                neighbors = new Map();
                adjacency.set(id, neighbors);
            }
            return neighbors;
        };

        for (const edge of edges) {
            const srcNeighbors = ensureNode(edge.src_symbol_version_id);
            const dstNeighbors = ensureNode(edge.dst_symbol_version_id);

            const existingSrc = srcNeighbors.get(edge.dst_symbol_version_id);
            if (!existingSrc || edge.confidence > existingSrc.confidence) {
                srcNeighbors.set(edge.dst_symbol_version_id, {
                    confidence: edge.confidence,
                    relation_type: edge.relation_type,
                });
            }

            const existingDst = dstNeighbors.get(edge.src_symbol_version_id);
            if (!existingDst || edge.confidence > existingDst.confidence) {
                dstNeighbors.set(edge.src_symbol_version_id, {
                    confidence: edge.confidence,
                    relation_type: edge.relation_type,
                });
            }
        }

        // Find connected components using BFS
        const visited = new Set<string>();
        const components: string[][] = [];
        const allNodes = Array.from(adjacency.keys());

        for (const node of allNodes) {
            if (visited.has(node)) continue;
            const component: string[] = [];
            const queue: string[] = [node];
            visited.add(node);

            while (queue.length > 0) {
                const current = queue.shift()!;
                component.push(current);
                const neighbors = adjacency.get(current);
                if (neighbors) {
                    for (const [neighbor] of neighbors) {
                        if (!visited.has(neighbor)) {
                            visited.add(neighbor);
                            queue.push(neighbor);
                        }
                    }
                }
            }

            components.push(component);
        }

        // Convert components to raw clusters, splitting oversized/low-density ones
        const clusters: RawCluster[] = [];

        for (const component of components) {
            if (component.length < MIN_FAMILY_SIZE) continue;

            const internalEdges = this.extractInternalEdges(component, adjacency);
            const avgConf = this.computeAvgConfidence(internalEdges);

            if (component.length > MAX_CLUSTER_SIZE_BEFORE_SPLIT || avgConf < MIN_INTERNAL_DENSITY) {
                // Attempt modularity-based bisection
                const subClusters = this.bisectCluster(component, adjacency);
                for (const sub of subClusters) {
                    if (sub.length < MIN_FAMILY_SIZE) continue;
                    const subEdges = this.extractInternalEdges(sub, adjacency);
                    const subAvg = this.computeAvgConfidence(subEdges);
                    clusters.push({
                        member_sv_ids: sub,
                        internal_edges: subEdges,
                        avg_confidence: subAvg,
                    });
                }
            } else {
                clusters.push({
                    member_sv_ids: component,
                    internal_edges: internalEdges,
                    avg_confidence: avgConf,
                });
            }
        }

        timer({ clusters: clusters.length, total_nodes: adjacency.size });
        return clusters;
    }

    /**
     * Structural fallback: cluster symbols by naming convention patterns.
     * Groups classes/functions sharing suffixes like *Engine, *Service, *Handler,
     * *Controller, *Repository, *Factory, *Middleware, *Validator, *Resolver.
     * Used when homolog edges are sparse (small repos).
     *
     * Gating: a naming-suffix bucket must also share a behavioral signal
     * (matching purity_class or overlapping effect categories) before it
     * becomes a cluster. This prevents grouping by coincidental name overlap —
     * e.g. `queryWithClient` (runs DB queries) and `lockClient` (acquires a
     * Postgres advisory lock) both end in `Client` but have nothing else in
     * common. Bucket members are split into behaviorally-compatible sub-groups
     * and each sub-group becomes its own cluster.
     */
    private async clusterByNamingPatterns(snapshotId: string): Promise<RawCluster[]> {
        const result = await db.query(`
            SELECT sv.symbol_version_id, s.canonical_name, s.kind
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE sv.snapshot_id = $1
            AND s.kind IN ('class', 'function', 'method')
        `, [snapshotId]);

        const rows = result.rows as { symbol_version_id: string; canonical_name: string; kind: string }[];
        const SUFFIXES = [
            'Engine', 'Service', 'Handler', 'Controller', 'Repository',
            'Factory', 'Middleware', 'Validator', 'Resolver', 'Provider',
            'Manager', 'Adapter', 'Client', 'Worker', 'Processor',
        ];

        const buckets = new Map<string, string[]>();
        for (const row of rows) {
            for (const suffix of SUFFIXES) {
                if (row.canonical_name.endsWith(suffix) && row.canonical_name.length > suffix.length) {
                    const key = `suffix:${suffix}`;
                    const existing = buckets.get(key) || [];
                    existing.push(row.symbol_version_id);
                    buckets.set(key, existing);
                    break;
                }
            }
        }

        // Collect all candidate svIds so we can batch-load behavioral profiles.
        const allCandidates: string[] = [];
        for (const members of buckets.values()) {
            for (const id of members) allCandidates.push(id);
        }
        if (allCandidates.length === 0) return [];

        const loader = new BatchLoader();
        const behavioralMap = await loader.loadBehavioralProfiles(allCandidates);

        const clusters: RawCluster[] = [];
        for (const [, members] of buckets) {
            if (members.length < MIN_FAMILY_SIZE) continue;

            // Sub-cluster within the bucket by behavioral fingerprint. Members
            // without profiles share a dedicated "unknown" bucket — they pair
            // only with each other, never with profiled members.
            const subBuckets = new Map<string, string[]>();
            for (const svId of members) {
                const bp = behavioralMap.get(svId);
                const fingerprint = this.behavioralFingerprint(bp);
                const existing = subBuckets.get(fingerprint) || [];
                existing.push(svId);
                subBuckets.set(fingerprint, existing);
            }

            for (const [, subMembers] of subBuckets) {
                if (subMembers.length < MIN_FAMILY_SIZE) continue;
                // Build synthetic edges between all sub-members
                const edges: EdgeRecord[] = [];
                for (let i = 0; i < subMembers.length; i++) {
                    for (let j = i + 1; j < subMembers.length; j++) {
                        edges.push({
                            src: subMembers[i]!, dst: subMembers[j]!,
                            confidence: 0.45, relation_type: 'naming_pattern',
                        });
                    }
                }
                clusters.push({
                    member_sv_ids: subMembers,
                    internal_edges: edges,
                    avg_confidence: 0.45,
                });
            }
        }

        return clusters;
    }

    /**
     * Compact behavioral fingerprint used to sub-bucket a naming cluster.
     * Members sharing a fingerprint have the same purity class AND the
     * same high-level effect categories (db read/write, network, file,
     * cache, auth). Bucketing on (purity × effect-set) is strict enough
     * to separate `queryWithClient` from `lockClient` while still
     * grouping genuine concept families.
     */
    private behavioralFingerprint(bp: BehavioralProfile | undefined): string {
        if (!bp) return 'unknown';
        const parts: string[] = [bp.purity_class];
        if ((bp.db_reads?.length ?? 0) > 0) parts.push('r');
        if ((bp.db_writes?.length ?? 0) > 0) parts.push('w');
        if ((bp.network_calls?.length ?? 0) > 0) parts.push('n');
        if ((bp.file_io?.length ?? 0) > 0) parts.push('f');
        if ((bp.cache_ops?.length ?? 0) > 0) parts.push('c');
        if ((bp.auth_operations?.length ?? 0) > 0) parts.push('a');
        if ((bp.transaction_profile?.length ?? 0) > 0) parts.push('t');
        return parts.join('|');
    }

    /**
     * Extract internal edges for a set of nodes from the adjacency graph.
     */
    private extractInternalEdges(
        nodes: string[],
        adjacency: Map<string, Map<string, AdjacencyData>>
    ): EdgeRecord[] {
        const nodeSet = new Set(nodes);
        const edgeList: EdgeRecord[] = [];
        const seen = new Set<string>();

        for (const node of nodes) {
            const neighbors = adjacency.get(node);
            if (!neighbors) continue;
            for (const [neighbor, data] of neighbors) {
                if (!nodeSet.has(neighbor)) continue;
                const edgeKey = node < neighbor ? `${node}:${neighbor}` : `${neighbor}:${node}`;
                if (seen.has(edgeKey)) continue;
                seen.add(edgeKey);
                edgeList.push({
                    src: node, dst: neighbor,
                    confidence: data.confidence,
                    relation_type: data.relation_type,
                });
            }
        }

        return edgeList;
    }

    /**
     * Compute average confidence across edges.
     */
    private computeAvgConfidence(edgeList: Array<{ confidence: number }>): number {
        if (edgeList.length === 0) return 0;
        const sum = edgeList.reduce((acc, e) => acc + e.confidence, 0);
        return sum / edgeList.length;
    }

    /**
     * Modularity-based bisection for splitting large or low-density clusters.
     *
     * Uses a greedy Kernighan-Lin style approach:
     *   1. Pick the node with lowest average edge weight to others as seed for partition B
     *   2. Iteratively move nodes to the partition that maximizes modularity gain
     *   3. Return the two partitions (or original if bisection does not improve quality)
     */
    private bisectCluster(
        nodes: string[],
        adjacency: Map<string, Map<string, AdjacencyData>>
    ): string[][] {
        if (nodes.length <= MIN_FAMILY_SIZE * 2) {
            return [nodes];
        }

        const nodeSet = new Set(nodes);

        // Compute weighted degree and edge weights within the subgraph
        const degree = new Map<string, number>();
        const weightMatrix = new Map<string, Map<string, number>>();
        let totalWeight = 0;

        for (const node of nodes) {
            let nodeDeg = 0;
            const neighbors = adjacency.get(node);
            if (!neighbors) {
                degree.set(node, 0);
                weightMatrix.set(node, new Map());
                continue;
            }
            const nodeWeights = new Map<string, number>();
            for (const [neighbor, data] of neighbors) {
                if (!nodeSet.has(neighbor)) continue;
                nodeWeights.set(neighbor, data.confidence);
                nodeDeg += data.confidence;
                totalWeight += data.confidence;
            }
            weightMatrix.set(node, nodeWeights);
            degree.set(node, nodeDeg);
        }

        // totalWeight is double-counted (undirected), so divide by 2 for m
        const m = totalWeight / 2;
        if (m === 0) return [nodes];

        // Initialize partition: find the node with lowest avg edge weight as seed for B
        let minAvgNode = nodes[0] ?? '';
        let minAvgWeight = Infinity;
        for (const node of nodes) {
            const deg = degree.get(node) || 0;
            const nw = weightMatrix.get(node);
            const neighborCount = nw ? nw.size : 1;
            const avgWeight = deg / Math.max(neighborCount, 1);
            if (avgWeight < minAvgWeight) {
                minAvgWeight = avgWeight;
                minAvgNode = node;
            }
        }

        // Start with minAvgNode in partition B, rest in partition A
        const partitionA = new Set<string>(nodes.filter(n => n !== minAvgNode));
        const partitionB = new Set<string>([minAvgNode]);

        // Greedy Kernighan-Lin: iteratively move nodes to improve modularity
        const MAX_PASSES = 10;
        let improved = true;

        for (let pass = 0; pass < MAX_PASSES && improved; pass++) {
            improved = false;

            for (const node of nodes) {
                const inA = partitionA.has(node);
                const inB = partitionB.has(node);
                if (!inA && !inB) continue;

                const currentPartition = inA ? partitionA : partitionB;
                const otherPartition = inA ? partitionB : partitionA;
                if (currentPartition.size <= 1) continue;

                const delta = this.computeModularityDelta(
                    node, currentPartition, otherPartition,
                    weightMatrix, degree, m
                );

                if (delta > 0.001) {
                    currentPartition.delete(node);
                    otherPartition.add(node);
                    improved = true;
                }
            }
        }

        const resultA = Array.from(partitionA);
        const resultB = Array.from(partitionB);

        if (resultA.length < MIN_FAMILY_SIZE && resultB.length < MIN_FAMILY_SIZE) {
            return [nodes];
        }

        const results: string[][] = [];
        if (resultA.length >= MIN_FAMILY_SIZE) results.push(resultA);
        if (resultB.length >= MIN_FAMILY_SIZE) results.push(resultB);

        if (results.length < 2) return [nodes];

        // Recursively bisect if any partition is still too large/low-density
        const finalResults: string[][] = [];
        for (const partition of results) {
            if (partition.length > MAX_CLUSTER_SIZE_BEFORE_SPLIT) {
                const subClusters = this.bisectCluster(partition, adjacency);
                finalResults.push(...subClusters);
            } else {
                const subEdges = this.extractInternalEdges(partition, adjacency);
                const subAvg = this.computeAvgConfidence(subEdges);
                if (partition.length > MAX_CLUSTER_SIZE_BEFORE_SPLIT / 2 && subAvg < MIN_INTERNAL_DENSITY) {
                    const subClusters = this.bisectCluster(partition, adjacency);
                    finalResults.push(...subClusters);
                } else {
                    finalResults.push(partition);
                }
            }
        }

        return finalResults;
    }

    /**
     * Compute the modularity delta for moving a node from its current partition
     * to the other partition.
     *
     * delta_Q = [ (sum_to_other - sum_to_current) / m ]
     *         + degree_node * (sum_degrees_current - sum_degrees_other) / (2m^2)
     */
    private computeModularityDelta(
        node: string,
        currentPartition: Set<string>,
        otherPartition: Set<string>,
        weightMatrix: Map<string, Map<string, number>>,
        degree: Map<string, number>,
        m: number
    ): number {
        const nodeWeights = weightMatrix.get(node);
        const nodeDeg = degree.get(node) || 0;

        let sumToCurrent = 0;
        let sumToOther = 0;

        if (nodeWeights) {
            for (const [neighbor, weight] of nodeWeights) {
                if (currentPartition.has(neighbor) && neighbor !== node) {
                    sumToCurrent += weight;
                }
                if (otherPartition.has(neighbor)) {
                    sumToOther += weight;
                }
            }
        }

        let sumDegreesCurrent = 0;
        for (const n of currentPartition) {
            if (n !== node) sumDegreesCurrent += (degree.get(n) || 0);
        }
        let sumDegreesOther = 0;
        for (const n of otherPartition) {
            sumDegreesOther += (degree.get(n) || 0);
        }

        if (m === 0) return 0;

        const delta = (sumToOther - sumToCurrent) / m
            + nodeDeg * (sumDegreesCurrent - sumDegreesOther) / (2 * m * m);

        return delta;
    }

    // ────────── 2. Family Type Classification ──────────

    /**
     * Classify family type by majority vote on member symbol kinds and behavioral patterns.
     *
     * Classification priority:
     *   1. Kind-based: validator, serializer, query_builder
     *   2. Behavioral: auth_policy, normalization, billing_rule, feature_gate, error_handler
     *   3. Fallback: business_rule (if behavioral data exists), custom (otherwise)
     */
    public classifyFamilyType(
        memberSvIds: string[],
        memberData: MemberData[],
        behavioralMap?: Map<string, BehavioralProfile>
    ): string {
        if (memberData.length === 0) return 'custom';

        const total = memberData.length;
        const majorityThreshold = total / 2;

        // Count kinds
        const kindCounts = new Map<string, number>();
        for (const md of memberData) {
            kindCounts.set(md.kind, (kindCounts.get(md.kind) || 0) + 1);
        }

        // Kind-based classification (majority vote)
        const validatorCount = (kindCounts.get('validator') || 0) + (kindCounts.get('schema_object') || 0);
        if (validatorCount > majorityThreshold) return 'validator';

        if ((kindCounts.get('serializer') || 0) > majorityThreshold) return 'serializer';
        if ((kindCounts.get('query_builder') || 0) > majorityThreshold) return 'query_builder';

        // Behavioral pattern-based classification (requires profiles)
        if (behavioralMap && behavioralMap.size > 0) {
            let authCount = 0;
            let validationCount = 0;
            let errorHandlerCount = 0;
            let dbWriteCount = 0;
            let featureGateCount = 0;
            let billingCount = 0;

            for (const svId of memberSvIds) {
                const bp = behavioralMap.get(svId);
                if (!bp) continue;

                if (bp.auth_operations && bp.auth_operations.length > 0) authCount++;
                if (bp.validation_operations && bp.validation_operations.length > 0) validationCount++;
                if (bp.db_writes && bp.db_writes.length > 0) dbWriteCount++;

                // Error handler: has catch/throw patterns
                const exceptions = bp.exception_profile || [];
                const hasCatchOrThrow = exceptions.some(
                    e => e.startsWith('catches:') || e.startsWith('throws:')
                );
                if (hasCatchOrThrow) errorHandlerCount++;

                // Feature gate: resource touches contain feature-flag-like patterns
                const resources = bp.resource_touches || [];
                const hasFeatureFlag = resources.some(r =>
                    /feature[_-]?flag|feature[_-]?gate|toggle|experiment|flag[_-]?check/i.test(r)
                );
                if (hasFeatureFlag) featureGateCount++;

                // Billing: resource touches or name contains billing-related terms
                const isBillingRes = resources.some(r =>
                    /billing|invoice|payment|charge|subscription|price|cost|credit|debit/i.test(r)
                );
                const md = memberData.find(m => m.symbol_version_id === svId);
                const nameBilling = md
                    ? /billing|invoice|payment|charge|subscription|price/i.test(md.canonical_name)
                    : false;
                if (isBillingRes || nameBilling) billingCount++;
            }

            if (authCount > majorityThreshold) return 'auth_policy';
            if (validationCount > majorityThreshold && authCount <= 1 && dbWriteCount <= 1) return 'normalization';
            if (featureGateCount > majorityThreshold) return 'feature_gate';
            if (errorHandlerCount > majorityThreshold) return 'error_handler';
            if (billingCount > majorityThreshold) return 'billing_rule';
        }

        // Name-based heuristics as fallback
        let nameValidatorCount = 0;
        let nameNormalizerCount = 0;
        let nameAuthCount = 0;
        let nameSerializerCount = 0;
        for (const md of memberData) {
            const name = md.canonical_name.toLowerCase();
            if (/validat|check|verify|assert|ensure/.test(name)) nameValidatorCount++;
            if (/normaliz|sanitiz|clean|trim|format/.test(name)) nameNormalizerCount++;
            if (/auth|guard|permission|role|policy|security/.test(name)) nameAuthCount++;
            if (/serial|marshal|encode|decode|transform|convert/.test(name)) nameSerializerCount++;
        }

        if (nameValidatorCount > majorityThreshold) return 'validator';
        if (nameNormalizerCount > majorityThreshold) return 'normalization';
        if (nameAuthCount > majorityThreshold) return 'auth_policy';
        if (nameSerializerCount > majorityThreshold) return 'serializer';

        // Default: business_rule if behavioral data available, otherwise custom
        if (behavioralMap && behavioralMap.size > 0) return 'business_rule';
        return 'custom';
    }

    // ────────── 3. Exemplar Selection ──────────

    /**
     * Select the canonical exemplar for a family (async version, loads data from DB).
     */
    public async selectExemplar(familySvIds: string[], _snapshotId: string): Promise<string> {
        if (familySvIds.length === 0) return '';
        if (familySvIds.length === 1) return familySvIds[0] ?? '';

        // Load edges from DB
        const edgeResult = await db.query(`
            SELECT ir.src_symbol_version_id as src, ir.dst_symbol_version_id as dst, ir.confidence
            FROM inferred_relations ir
            WHERE ir.src_symbol_version_id = ANY($1)
            AND ir.dst_symbol_version_id = ANY($1)
            AND ir.confidence >= $2
            AND ir.review_state != 'rejected'
            AND ir.valid_to_snapshot_id IS NULL
        `, [familySvIds, MIN_EDGE_CONFIDENCE]);

        const edges = edgeResult.rows as Array<{ src: string; dst: string; confidence: number }>;

        const loader = new BatchLoader();
        const [bpMap, cpMap] = await Promise.all([
            loader.loadBehavioralProfiles(familySvIds),
            loader.loadContractProfiles(familySvIds),
        ]);

        return this.selectExemplarSync(familySvIds, edges, bpMap, cpMap);
    }

    /**
     * Select exemplar from pre-loaded data (no DB calls).
     */
    private selectExemplarSync(
        familySvIds: string[],
        internalEdges: Array<{ src: string; dst: string; confidence: number }>,
        behavioralMap: Map<string, BehavioralProfile>,
        contractMap: Map<string, ContractProfile>
    ): string {
        if (familySvIds.length === 0) return '';
        if (familySvIds.length === 1) return familySvIds[0] ?? '';

        // Compute average similarity to all other members for each candidate
        const avgSimilarity = new Map<string, number>();
        for (const svId of familySvIds) {
            const sims: number[] = [];
            for (const edge of internalEdges) {
                if (edge.src === svId) sims.push(edge.confidence);
                if (edge.dst === svId) sims.push(edge.confidence);
            }
            avgSimilarity.set(svId, sims.length > 0 ? sims.reduce((a, b) => a + b, 0) / sims.length : 0);
        }

        let bestSvId = familySvIds[0] ?? '';
        let bestScore = -Infinity;

        for (const svId of familySvIds) {
            let score = 0;

            // Factor 1: Average similarity (weight 0.6)
            score += (avgSimilarity.get(svId) || 0) * 0.6;

            // Factor 2: Profile completeness (weight 0.4)
            const completeness = this.computeProfileCompleteness(svId, behavioralMap, contractMap);
            score += completeness * 0.4;

            if (score > bestScore) {
                bestScore = score;
                bestSvId = svId;
            }
        }

        // Guard against outlier exemplar
        const familyAvgSim = this.computeFamilyAvgSimilarity(familySvIds, internalEdges);
        const exemplarSim = avgSimilarity.get(bestSvId) || 0;

        if (exemplarSim < familyAvgSim * OUTLIER_THRESHOLD_FACTOR && familySvIds.length > 2) {
            let fallbackId = familySvIds[0] ?? '';
            let fallbackSim = 0;
            for (const svId of familySvIds) {
                const sim = avgSimilarity.get(svId) || 0;
                if (sim > fallbackSim) {
                    fallbackSim = sim;
                    fallbackId = svId;
                }
            }
            return fallbackId;
        }

        return bestSvId;
    }

    /**
     * Compute how complete a member's behavioral + contract profile is.
     * Returns 0.0-1.0.
     */
    private computeProfileCompleteness(
        svId: string,
        behavioralMap: Map<string, BehavioralProfile>,
        contractMap: Map<string, ContractProfile>
    ): number {
        let fields = 0;
        let populated = 0;

        const bp = behavioralMap.get(svId);
        fields += 7;
        if (bp) {
            if (bp.purity_class) populated++;
            if (bp.resource_touches && bp.resource_touches.length > 0) populated++;
            if (bp.db_reads && bp.db_reads.length > 0) populated++;
            if (bp.db_writes && bp.db_writes.length > 0) populated++;
            if (bp.network_calls && bp.network_calls.length > 0) populated++;
            if (bp.exception_profile && bp.exception_profile.length > 0) populated++;
            if (bp.auth_operations && bp.auth_operations.length > 0) populated++;
        }

        const cp = contractMap.get(svId);
        fields += 5;
        if (cp) {
            if (cp.input_contract && cp.input_contract !== 'void') populated++;
            if (cp.output_contract && cp.output_contract !== 'void') populated++;
            if (cp.error_contract && cp.error_contract !== 'never') populated++;
            if (cp.security_contract && cp.security_contract !== 'none') populated++;
            if (cp.serialization_contract && cp.serialization_contract !== 'none') populated++;
        }

        return fields > 0 ? populated / fields : 0;
    }

    /**
     * Compute average pairwise similarity for the family from edges.
     */
    private computeFamilyAvgSimilarity(
        familySvIds: string[],
        edges: Array<{ src: string; dst: string; confidence: number }>
    ): number {
        const memberSet = new Set(familySvIds);
        const relevantEdges = edges.filter(
            e => memberSet.has(e.src) && memberSet.has(e.dst)
        );
        if (relevantEdges.length === 0) return 0;
        return relevantEdges.reduce((sum, e) => sum + e.confidence, 0) / relevantEdges.length;
    }

    // ────────── 4. Family Fingerprinting ──────────

    /**
     * Compute family fingerprints (async version that loads from DB).
     *
     * Contract fingerprint: intersection of all member contracts (the "family contract").
     * Effect fingerprint: union of all member effect types.
     */
    public async computeFingerprints(
        familySvIds: string[]
    ): Promise<{ contract: string; effect: string }> {
        if (familySvIds.length === 0) return { contract: '{}', effect: '{}' };

        const loader = new BatchLoader();
        const [behavioralMap, contractMap] = await Promise.all([
            loader.loadBehavioralProfiles(familySvIds),
            loader.loadContractProfiles(familySvIds),
        ]);

        return this.computeFingerprintsFromCache(familySvIds, behavioralMap, contractMap);
    }

    /**
     * Compute fingerprints from already-loaded maps (avoids redundant DB calls).
     */
    private computeFingerprintsFromCache(
        familySvIds: string[],
        behavioralMap: Map<string, BehavioralProfile>,
        contractMap: Map<string, ContractProfile>
    ): { contract: string; effect: string } {
        // Contract fingerprint: token-level intersection across all members.
        // Each contract field is tokenized (e.g. "(string, number) => boolean"
        // becomes ["string", "number", "boolean"]) and we keep tokens that
        // appear in >50% of members (majority intersection).
        const fieldNames = ['input_contract', 'output_contract', 'error_contract',
            'security_contract', 'serialization_contract'] as const;

        // Count how many members contributed a contract (non-null)
        const tokenFrequency: Record<string, Map<string, number>> = {};
        for (const field of fieldNames) {
            tokenFrequency[field] = new Map<string, number>();
        }
        let memberCount = 0;

        for (const svId of familySvIds) {
            const cp = contractMap.get(svId);
            if (!cp) continue;
            memberCount++;

            for (const field of fieldNames) {
                const value = cp[field];
                if (!value) continue;
                const tokens = this.tokenizeContract(value);
                // Count each unique token once per member
                const seen = new Set<string>();
                for (const token of tokens) {
                    if (!seen.has(token)) {
                        seen.add(token);
                        const freq = tokenFrequency[field]!;
                        freq.set(token, (freq.get(token) || 0) + 1);
                    }
                }
            }
        }

        // Keep tokens that appear in >50% of members
        const threshold = memberCount > 0 ? memberCount * 0.5 : 0;
        const contractResult: Record<string, string[]> = {};
        for (const field of fieldNames) {
            const shortName = field.replace('_contract', '');
            const freq = tokenFrequency[field]!;
            const kept: string[] = [];
            for (const [token, count] of freq) {
                if (count > threshold) {
                    kept.push(token);
                }
            }
            contractResult[shortName] = kept.sort();
        }

        const contractFingerprint = JSON.stringify(contractResult);

        // Effect fingerprint: union of all member effect types
        const allEffects = new Set<string>();
        for (const svId of familySvIds) {
            const bp = behavioralMap.get(svId);
            if (!bp) continue;

            allEffects.add(`purity:${bp.purity_class}`);

            for (const r of bp.resource_touches || []) {
                const category = r.split(':')[0];
                if (category) allEffects.add(`effect:${category}`);
            }

            if (bp.db_reads && bp.db_reads.length > 0) allEffects.add('effect:db_read');
            if (bp.db_writes && bp.db_writes.length > 0) allEffects.add('effect:db_write');
            if (bp.network_calls && bp.network_calls.length > 0) allEffects.add('effect:network');
            if (bp.file_io && bp.file_io.length > 0) allEffects.add('effect:file_io');
            if (bp.cache_ops && bp.cache_ops.length > 0) allEffects.add('effect:cache');
            if (bp.auth_operations && bp.auth_operations.length > 0) allEffects.add('effect:auth');
            if (bp.state_mutation_profile && bp.state_mutation_profile.length > 0) allEffects.add('effect:state_mutation');
            if (bp.transaction_profile && bp.transaction_profile.length > 0) allEffects.add('effect:transaction');
        }

        const effectFingerprint = JSON.stringify(Array.from(allEffects).sort());

        return { contract: contractFingerprint, effect: effectFingerprint };
    }

    /**
     * Tokenize a contract string by splitting on common delimiters
     * (parentheses, commas, arrows, pipes, spaces, braces, brackets, colons).
     * Filters out empty tokens and normalizes to lowercase.
     */
    private tokenizeContract(contract: string): string[] {
        return contract
            .split(/[\s,()=>{}|:;\][]+/)
            .map(t => t.trim().toLowerCase())
            .filter(t => t.length > 0);
    }

    // ────────── 5. Outlier and Contradiction Detection ──────────

    /**
     * Detect outliers and contradictions for each family member (async, loads from DB).
     */
    public async detectOutliers(
        familySvIds: string[],
        exemplarSvId: string
    ): Promise<OutlierResult[]> {
        if (familySvIds.length === 0) return [];

        const edgeResult = await db.query(`
            SELECT ir.src_symbol_version_id as src, ir.dst_symbol_version_id as dst, ir.confidence
            FROM inferred_relations ir
            WHERE ir.src_symbol_version_id = ANY($1)
            AND ir.dst_symbol_version_id = ANY($1)
            AND ir.confidence >= $2
            AND ir.review_state != 'rejected'
            AND ir.valid_to_snapshot_id IS NULL
        `, [familySvIds, MIN_EDGE_CONFIDENCE]);

        const edges = edgeResult.rows as Array<{ src: string; dst: string; confidence: number }>;

        const loader = new BatchLoader();
        const [behavioralMap, contractMap] = await Promise.all([
            loader.loadBehavioralProfiles(familySvIds),
            loader.loadContractProfiles(familySvIds),
        ]);

        return this.detectOutliersFromCache(familySvIds, exemplarSvId, edges, behavioralMap, contractMap);
    }

    /**
     * Detect outliers from cached data (avoids redundant DB calls).
     */
    private detectOutliersFromCache(
        familySvIds: string[],
        exemplarSvId: string,
        edges: Array<{ src: string; dst: string; confidence: number }>,
        behavioralMap: Map<string, BehavioralProfile>,
        contractMap: Map<string, ContractProfile>
    ): OutlierResult[] {
        // Compute similarity to exemplar for each member
        const simToExemplar = new Map<string, number>();
        for (const svId of familySvIds) {
            if (svId === exemplarSvId) {
                simToExemplar.set(svId, 1.0);
                continue;
            }
            // Find the direct edge between this member and the exemplar
            const directEdge = edges.find(
                e => (e.src === svId && e.dst === exemplarSvId) ||
                     (e.dst === svId && e.src === exemplarSvId)
            );

            if (directEdge) {
                simToExemplar.set(svId, directEdge.confidence);
            } else {
                // No direct edge — compute avg via shared neighbors as proxy
                const memberEdges = edges.filter(
                    e => e.src === svId || e.dst === svId
                );
                if (memberEdges.length > 0) {
                    const avgSim = memberEdges.reduce((sum, e) => sum + e.confidence, 0) / memberEdges.length;
                    simToExemplar.set(svId, avgSim * 0.8); // Discount for indirect
                } else {
                    simToExemplar.set(svId, 0.0);
                }
            }
        }

        // Compute family average similarity
        const familyAvgSim = this.computeFamilyAvgSimilarity(familySvIds, edges);
        const outlierThreshold = familyAvgSim * OUTLIER_THRESHOLD_FACTOR;

        // Get exemplar profiles for comparison
        const exemplarBp = behavioralMap.get(exemplarSvId);
        const exemplarCp = contractMap.get(exemplarSvId);

        const results: OutlierResult[] = [];

        for (const svId of familySvIds) {
            const similarity = simToExemplar.get(svId) || 0;
            const isOutlier = svId !== exemplarSvId && similarity < outlierThreshold;

            // Detect behavioral contradictions
            const contradictionFlags: string[] = [];
            const memberBp = behavioralMap.get(svId);
            const memberCp = contractMap.get(svId);

            let contractDeviation: string | null = null;
            let effectDeviation: string | null = null;

            if (exemplarBp && memberBp) {
                // Different purity class
                if (exemplarBp.purity_class !== memberBp.purity_class) {
                    contradictionFlags.push(
                        `purity_diverges:${exemplarBp.purity_class}->${memberBp.purity_class}`
                    );
                }

                // Different auth requirements
                const exemplarHasAuth = (exemplarBp.auth_operations || []).length > 0;
                const memberHasAuth = (memberBp.auth_operations || []).length > 0;
                if (exemplarHasAuth !== memberHasAuth) {
                    contradictionFlags.push('auth_requirement_differs');
                }

                // Effect deviation: member has effects not present in exemplar
                const exemplarEffects = new Set<string>();
                if (exemplarBp.db_reads && exemplarBp.db_reads.length > 0) exemplarEffects.add('db_read');
                if (exemplarBp.db_writes && exemplarBp.db_writes.length > 0) exemplarEffects.add('db_write');
                if (exemplarBp.network_calls && exemplarBp.network_calls.length > 0) exemplarEffects.add('network');
                if (exemplarBp.file_io && exemplarBp.file_io.length > 0) exemplarEffects.add('file_io');
                if (exemplarBp.cache_ops && exemplarBp.cache_ops.length > 0) exemplarEffects.add('cache');

                const memberEffects = new Set<string>();
                if (memberBp.db_reads && memberBp.db_reads.length > 0) memberEffects.add('db_read');
                if (memberBp.db_writes && memberBp.db_writes.length > 0) memberEffects.add('db_write');
                if (memberBp.network_calls && memberBp.network_calls.length > 0) memberEffects.add('network');
                if (memberBp.file_io && memberBp.file_io.length > 0) memberEffects.add('file_io');
                if (memberBp.cache_ops && memberBp.cache_ops.length > 0) memberEffects.add('cache');

                const extraEffects: string[] = [];
                for (const e of memberEffects) {
                    if (!exemplarEffects.has(e)) extraEffects.push(e);
                }
                const missingEffects: string[] = [];
                for (const e of exemplarEffects) {
                    if (!memberEffects.has(e)) missingEffects.push(e);
                }

                if (extraEffects.length > 0 || missingEffects.length > 0) {
                    const parts: string[] = [];
                    if (extraEffects.length > 0) parts.push(`extra:[${extraEffects.join(',')}]`);
                    if (missingEffects.length > 0) parts.push(`missing:[${missingEffects.join(',')}]`);
                    effectDeviation = parts.join('; ');
                    if (extraEffects.length > 0) {
                        contradictionFlags.push('effect_set_diverges');
                    }
                }

                // Different exception semantics
                const exemplarExc = [...(exemplarBp.exception_profile || [])].sort().join(',');
                const memberExc = [...(memberBp.exception_profile || [])].sort().join(',');
                if (exemplarExc !== memberExc && exemplarExc.length > 0 && memberExc.length > 0) {
                    contradictionFlags.push('exception_semantics_differ');
                }
            }

            if (exemplarCp && memberCp) {
                // Different error contracts
                if (exemplarCp.error_contract !== memberCp.error_contract
                    && exemplarCp.error_contract !== 'never' && memberCp.error_contract !== 'never') {
                    contradictionFlags.push('error_contract_diverges');
                }

                // Different security contracts
                if (exemplarCp.security_contract !== memberCp.security_contract
                    && exemplarCp.security_contract !== 'none' && memberCp.security_contract !== 'none') {
                    contradictionFlags.push('security_contract_diverges');
                }

                // Contract deviation summary
                const deviations: string[] = [];
                if (exemplarCp.input_contract !== memberCp.input_contract) {
                    deviations.push(`input:${exemplarCp.input_contract}->${memberCp.input_contract}`);
                }
                if (exemplarCp.output_contract !== memberCp.output_contract) {
                    deviations.push(`output:${exemplarCp.output_contract}->${memberCp.output_contract}`);
                }
                if (exemplarCp.error_contract !== memberCp.error_contract) {
                    deviations.push(`error:${exemplarCp.error_contract}->${memberCp.error_contract}`);
                }
                if (deviations.length > 0) {
                    contractDeviation = deviations.join('; ');
                }
            }

            const isContradicting = contradictionFlags.length > 0;

            results.push({
                symbol_version_id: svId,
                is_outlier: isOutlier,
                is_contradicting: isContradicting,
                similarity_to_exemplar: similarity,
                contradiction_flags: contradictionFlags,
                contract_deviation: contractDeviation,
                effect_deviation: effectDeviation,
            });
        }

        return results;
    }

    // ────────── 6. Query Methods ──────────

    /**
     * Get the concept family a symbol belongs to.
     */
    public async getFamilyForSymbol(symbolVersionId: string): Promise<ConceptFamily | null> {
        const result = await db.query(`
            SELECT cf.family_id, cf.repo_id, cf.snapshot_id, cf.family_name, cf.family_type,
                   cf.exemplar_symbol_version_id, cf.family_contract_fingerprint,
                   cf.family_effect_fingerprint, cf.member_count, cf.avg_confidence,
                   cf.contradiction_count, cf.created_at
            FROM concept_families cf
            JOIN concept_family_members cfm ON cfm.family_id = cf.family_id
            WHERE cfm.symbol_version_id = $1
            LIMIT 1
        `, [symbolVersionId]);

        return (result.rows[0] as ConceptFamily | undefined) ?? null;
    }

    /**
     * Get all concept families in a snapshot.
     */
    public async getFamilies(snapshotId: string): Promise<ConceptFamily[]> {
        const result = await db.query(`
            SELECT family_id, repo_id, snapshot_id, family_name, family_type,
                   exemplar_symbol_version_id, family_contract_fingerprint,
                   family_effect_fingerprint, member_count, avg_confidence,
                   contradiction_count, created_at
            FROM concept_families
            WHERE snapshot_id = $1
            ORDER BY member_count DESC, family_name ASC
        `, [snapshotId]);

        return result.rows as ConceptFamily[];
    }

    /**
     * Get all members of a concept family.
     */
    public async getFamilyMembers(familyId: string): Promise<ConceptFamilyMember[]> {
        const result = await db.query(`
            SELECT member_id, family_id, symbol_version_id, is_exemplar, is_outlier,
                   is_contradicting, similarity_to_exemplar, membership_confidence,
                   contradiction_flags, contract_deviation, effect_deviation
            FROM concept_family_members
            WHERE family_id = $1
            ORDER BY is_exemplar DESC, similarity_to_exemplar DESC
        `, [familyId]);

        return result.rows as ConceptFamilyMember[];
    }

    /**
     * Get families with their members in a single query.
     */
    public async getFamiliesWithMembers(
        snapshotId: string
    ): Promise<Array<ConceptFamily & { members: ConceptFamilyMember[] }>> {
        const families = await this.getFamilies(snapshotId);
        if (families.length === 0) return [];

        const familyIds = families.map(f => f.family_id);
        const placeholders = familyIds.map((_, i) => `$${i + 1}`).join(',');

        const memberResult = await db.query(
            `SELECT member_id, family_id, symbol_version_id, is_exemplar, is_outlier,
                    is_contradicting, similarity_to_exemplar, membership_confidence,
                    contradiction_flags, contract_deviation, effect_deviation
             FROM concept_family_members WHERE family_id IN (${placeholders})
             ORDER BY is_exemplar DESC, similarity_to_exemplar DESC`,
            familyIds
        );

        const membersByFamily = new Map<string, ConceptFamilyMember[]>();
        for (const row of memberResult.rows as ConceptFamilyMember[]) {
            const existing = membersByFamily.get(row.family_id) || [];
            existing.push(row);
            membersByFamily.set(row.family_id, existing);
        }

        return families.map(f => ({
            ...f,
            members: membersByFamily.get(f.family_id) || [],
        }));
    }

    // ────────── Helpers ──────────

    /**
     * Load symbol metadata for a set of symbol version IDs.
     */
    private async loadMemberData(svIds: string[]): Promise<Map<string, MemberData>> {
        if (svIds.length === 0) return new Map();

        const result = new Map<string, MemberData>();
        const CHUNK_SIZE = 5000;

        for (let i = 0; i < svIds.length; i += CHUNK_SIZE) {
            const chunk = svIds.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map((_, j) => `$${j + 1}`).join(',');
            const queryResult = await db.query(`
                SELECT sv.symbol_version_id, s.canonical_name, s.kind, s.stable_key
                FROM symbol_versions sv
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                WHERE sv.symbol_version_id IN (${placeholders})
            `, chunk);

            for (const row of queryResult.rows as MemberData[]) {
                result.set(row.symbol_version_id, row);
            }
        }

        return result;
    }

    /**
     * Generate a human-readable family name from member data and type.
     */
    private generateFamilyName(memberData: MemberData[], familyType: string): string {
        if (memberData.length === 0) return `unnamed_${familyType}`;

        // Find common name tokens across members
        const tokenSets: Array<Set<string>> = memberData.map(m => this.tokenizeName(m.canonical_name));
        const firstSet = tokenSets[0];
        if (!firstSet) return `misc_${familyType}_family`;

        let commonTokens = new Set(firstSet);
        for (let i = 1; i < tokenSets.length; i++) {
            const nextSet = tokenSets[i];
            if (!nextSet) continue;
            const intersection = new Set<string>();
            for (const token of commonTokens) {
                if (nextSet.has(token)) intersection.add(token);
            }
            commonTokens = intersection;
        }

        // Build name from common tokens + type
        const commonPart = Array.from(commonTokens)
            .filter(t => t.length > 2)
            .sort()
            .join('_');

        if (commonPart.length > 0) {
            return `${commonPart}_${familyType}_family`;
        }

        // Fallback: use the first member's name + type
        const firstMember = memberData[0];
        if (!firstMember) return `misc_${familyType}_family`;
        const firstName = this.tokenizeName(firstMember.canonical_name);
        const firstPart = Array.from(firstName)
            .filter(t => t.length > 2)
            .slice(0, 2)
            .sort()
            .join('_');

        return `${firstPart || 'misc'}_${familyType}_family`;
    }

    /**
     * Tokenize a name for comparison (camelCase, PascalCase, snake_case).
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

    /**
     * Compute membership confidence for a member within a cluster.
     * Based on the number and strength of edges connecting it to other cluster members.
     */
    private computeMembershipConfidence(svId: string, cluster: RawCluster): number {
        const memberEdges = cluster.internal_edges.filter(
            e => e.src === svId || e.dst === svId
        );

        if (memberEdges.length === 0) return 0;

        const maxPossibleEdges = cluster.member_sv_ids.length - 1;
        const coverage = maxPossibleEdges > 0 ? memberEdges.length / maxPossibleEdges : 0;
        const avgEdgeConf = memberEdges.reduce((sum, e) => sum + e.confidence, 0) / memberEdges.length;

        return Math.min(1.0, coverage * 0.4 + avgEdgeConf * 0.6);
    }
}

export const conceptFamilyEngine = new ConceptFamilyEngine();
