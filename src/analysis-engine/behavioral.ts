/**
 * ContextZero — Behavioral Fingerprint Engine
 *
 * Processes adapter behavior hints into structured behavioral profiles.
 * Every function is classified on a four-tier purity ladder:
 *   pure < read_only < read_write < side_effecting
 *
 * Classification:
 *   - Network or transaction operations → side_effecting
 *   - DB writes, state mutations, file I/O → read_write
 *   - Only reads (DB, cache, auth) → read_only
 *   - No I/O at all → pure
 */

import { db } from '../db-driver';
import { validateBehavioralProfile } from '../db-driver/result';
import { coreDataService } from '../db-driver/core_data';
import { Logger } from '../logger';
import type { BehaviorHint, BehavioralProfile, PurityClass } from '../types';

const log = new Logger('behavioral-engine');

export class BehavioralEngine {

    /**
     * Process raw behavior hints from adapter into structured profiles
     * and persist to DB.
     */
    public async extractBehavioralProfiles(
        symbolVersionId: string,
        hints: BehaviorHint[]
    ): Promise<Omit<BehavioralProfile, 'behavior_profile_id'>> {
        const timer = log.startTimer('extractBehavioralProfiles', {
            symbolVersionId,
            hintCount: hints.length,
        });

        const dbReads: string[] = [];
        const dbWrites: string[] = [];
        const networkCalls: string[] = [];
        const fileIo: string[] = [];
        const cacheOps: string[] = [];
        const authOps: string[] = [];
        const validationOps: string[] = [];
        const exceptions: string[] = [];
        const stateMutations: string[] = [];
        const transactions: string[] = [];
        const allResources: string[] = [];
        let hasLockOps = false;
        let hasConcurrencyOps = false;
        let hasCacheWrites = false;

        for (const hint of hints) {
            const detail = hint.detail;
            switch (hint.hint_type) {
                case 'db_read':
                    dbReads.push(detail);
                    allResources.push(`db:read:${detail}`);
                    break;
                case 'db_write':
                    dbWrites.push(detail);
                    allResources.push(`db:write:${detail}`);
                    break;
                case 'network_call':
                    networkCalls.push(detail);
                    allResources.push(`network:${detail}`);
                    break;
                case 'file_io':
                    fileIo.push(detail);
                    allResources.push(`file:${detail}`);
                    break;
                case 'cache_op':
                    cacheOps.push(detail);
                    allResources.push(`cache:${detail}`);
                    break;
                case 'cache_write':
                    cacheOps.push(detail);
                    hasCacheWrites = true;
                    allResources.push(`cache:write:${detail}`);
                    break;
                case 'auth_check':
                    authOps.push(detail);
                    allResources.push(`auth:${detail}`);
                    break;
                case 'validation':
                    validationOps.push(detail);
                    break;
                case 'throws':
                case 'catches':
                    exceptions.push(`${hint.hint_type}:${detail}`);
                    break;
                case 'state_mutation':
                    stateMutations.push(detail);
                    allResources.push(`state:${detail}`);
                    break;
                case 'transaction':
                    transactions.push(detail);
                    allResources.push(`txn:${detail}`);
                    break;
                case 'acquires_lock':
                    // Locks affect shared state — classify as side_effecting
                    hasLockOps = true;
                    allResources.push(`lock:${detail}`);
                    break;
                case 'concurrency':
                    // Spawning threads/goroutines/tasks — side_effecting
                    hasConcurrencyOps = true;
                    allResources.push(`concurrency:${detail}`);
                    break;
                case 'serialization':
                    // Pure data transformation — does not affect purity
                    allResources.push(`serialization:${detail}`);
                    break;
                case 'logging':
                    break;
                default: {
                    const exhaustiveCheck: never = hint.hint_type;
                    log.warn('Unhandled behavior hint type', { type: String(exhaustiveCheck) });
                    break;
                }
            }
        }

        const purityClass = this.classifyPurity({
            hasNetworkCalls: networkCalls.length > 0,
            hasTransactions: transactions.length > 0,
            hasDbWrites: dbWrites.length > 0,
            hasStateMutations: stateMutations.length > 0,
            hasFileIo: fileIo.length > 0,
            hasCacheOps: cacheOps.length > 0,
            hasCacheWrites,
            hasDbReads: dbReads.length > 0,
            hasAuthOps: authOps.length > 0,
            hasLockOps,
            hasConcurrencyOps,
        });

        const profile: Omit<BehavioralProfile, 'behavior_profile_id'> = {
            symbol_version_id: symbolVersionId,
            purity_class: purityClass,
            resource_touches: [...new Set(allResources)],
            db_reads: [...new Set(dbReads)],
            db_writes: [...new Set(dbWrites)],
            network_calls: [...new Set(networkCalls)],
            cache_ops: [...new Set(cacheOps)],
            file_io: [...new Set(fileIo)],
            auth_operations: [...new Set(authOps)],
            validation_operations: [...new Set(validationOps)],
            exception_profile: [...new Set(exceptions)],
            state_mutation_profile: [...new Set(stateMutations)],
            transaction_profile: [...new Set(transactions)],
        };

        await coreDataService.upsertBehavioralProfile(profile);
        timer({ purityClass });
        return profile;
    }

    /**
     * Classify purity based on observed resource access patterns.
     *
     * Purity ladder:
     *   pure → read_only → read_write → side_effecting
     *
     * Network/transaction → always side_effecting (external world mutation)
     * DB writes, state mutations, file I/O → read_write
     * Only DB reads, cache reads, auth checks → read_only
     * Nothing → pure
     */
    private classifyPurity(signals: {
        hasNetworkCalls: boolean;
        hasTransactions: boolean;
        hasDbWrites: boolean;
        hasStateMutations: boolean;
        hasFileIo: boolean;
        hasCacheOps: boolean;
        hasCacheWrites: boolean;
        hasDbReads: boolean;
        hasAuthOps: boolean;
        hasLockOps: boolean;
        hasConcurrencyOps: boolean;
    }): PurityClass {
        // Tier 1: Network calls, transactions, locks, or concurrency ops → side_effecting
        // These affect the external world or shared state in ways that cannot be undone
        if (signals.hasNetworkCalls || signals.hasTransactions ||
            signals.hasLockOps || signals.hasConcurrencyOps) {
            return 'side_effecting';
        }

        // Tier 2: DB writes, state mutations, file I/O, or cache writes → read_write
        if (signals.hasDbWrites || signals.hasStateMutations ||
            signals.hasFileIo || signals.hasCacheWrites) {
            return 'read_write';
        }

        // Tier 3: Only reads (DB, cache, auth checks) → read_only
        if (signals.hasDbReads || signals.hasCacheOps || signals.hasAuthOps) {
            return 'read_only';
        }

        // Tier 4: No I/O at all → pure
        return 'pure';
    }

    /**
     * Get behavioral profile for a symbol version.
     */
    public async getProfile(symbolVersionId: string): Promise<BehavioralProfile | null> {
        const result = await db.query(
            `SELECT * FROM behavioral_profiles WHERE symbol_version_id = $1`,
            [symbolVersionId]
        );
        if (!result.rows[0]) return null;
        return validateBehavioralProfile(result.rows[0] as Record<string, unknown>);
    }

    /**
     * Propagate behavioral profiles transitively through the call graph.
     *
     * Problem: if main() calls train() and train() calls torch.save(),
     * pattern matching only sees torch.save() in train()'s body. main()
     * gets classified as "pure" even though it transitively does file I/O.
     *
     * Solution: walk the call graph bottom-up. For each caller, merge
     * the callee's profile into the caller's profile. Repeat until no
     * changes (fixed-point). This propagates side effects upward through
     * the entire call chain.
     */
    public async propagateTransitive(snapshotId: string): Promise<number> {
        const timer = log.startTimer('propagateTransitive', { snapshotId });

        const purityOrder: Record<PurityClass, number> = {
            pure: 0, read_only: 1, read_write: 2, side_effecting: 3,
        };

        // Load all behavioral profiles for this snapshot
        const profileResult = await db.query(`
            SELECT bp.*, sv.symbol_version_id as svid
            FROM behavioral_profiles bp
            JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const profiles = new Map<string, {
            purity_class: PurityClass;
            resource_touches: string[];
            db_reads: string[];
            db_writes: string[];
            network_calls: string[];
            cache_ops: string[];
            file_io: string[];
            auth_operations: string[];
            state_mutation_profile: string[];
            transaction_profile: string[];
        }>();

        for (const row of profileResult.rows as Record<string, unknown>[]) {
            profiles.set(row.symbol_version_id as string, {
                purity_class: row.purity_class as PurityClass,
                resource_touches: (row.resource_touches as string[]) || [],
                db_reads: (row.db_reads as string[]) || [],
                db_writes: (row.db_writes as string[]) || [],
                network_calls: (row.network_calls as string[]) || [],
                cache_ops: (row.cache_ops as string[]) || [],
                file_io: (row.file_io as string[]) || [],
                auth_operations: (row.auth_operations as string[]) || [],
                state_mutation_profile: (row.state_mutation_profile as string[]) || [],
                transaction_profile: (row.transaction_profile as string[]) || [],
            });
        }

        // Load call graph edges for this snapshot
        const callResult = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
            AND sr.relation_type = 'calls'
        `, [snapshotId]);

        // Build adjacency: caller → [callees]
        const callGraph = new Map<string, string[]>();
        for (const row of callResult.rows as { src_symbol_version_id: string; dst_symbol_version_id: string }[]) {
            const existing = callGraph.get(row.src_symbol_version_id) || [];
            existing.push(row.dst_symbol_version_id);
            callGraph.set(row.src_symbol_version_id, existing);
        }

        // Topological propagation: walk the call graph bottom-up in a single pass.
        //
        // Strategy:
        //   1. Compute in-degree for each node (how many callees it has with profiles)
        //   2. Start from leaf nodes (callees with no further callees)
        //   3. Propagate effects upward through the graph
        //   4. Cycle members get flagged as circular_reference
        //
        // This replaces the old fixed-point iteration (MAX_ITERATIONS=10) which:
        //   - Could silently fail for deep call chains >10 levels
        //   - Used O(n²) Array.includes() for resource merging
        //   - Ran multiple full passes over the entire graph

        const changedSvIds = new Set<string>();

        // Build reverse graph: callee → [callers]
        const reverseGraph = new Map<string, string[]>();
        const inDegree = new Map<string, number>();

        // Initialize in-degrees
        for (const callerId of callGraph.keys()) {
            if (!inDegree.has(callerId)) inDegree.set(callerId, 0);
        }

        for (const [callerId, callees] of callGraph) {
            for (const calleeId of callees) {
                if (!profiles.has(calleeId)) continue; // Skip unresolved callees
                // Count how many profiled callees each caller has
                inDegree.set(callerId, (inDegree.get(callerId) || 0) + 1);
                // Build reverse: callee → callers
                const callers = reverseGraph.get(calleeId) || [];
                callers.push(callerId);
                reverseGraph.set(calleeId, callers);
                if (!inDegree.has(calleeId)) inDegree.set(calleeId, 0);
            }
        }

        // O(1) set-based merge utility
        const mergeUnique = (target: string[], source: string[], targetSet: Set<string>): boolean => {
            let merged = false;
            for (const item of source) {
                if (!targetSet.has(item)) {
                    target.push(item);
                    targetSet.add(item);
                    merged = true;
                }
            }
            return merged;
        };

        // Build per-profile Sets for O(1) membership checks
        const profileSets = new Map<string, {
            resource_touches: Set<string>;
            db_reads: Set<string>;
            db_writes: Set<string>;
            network_calls: Set<string>;
            cache_ops: Set<string>;
            file_io: Set<string>;
            auth_operations: Set<string>;
            state_mutation_profile: Set<string>;
            transaction_profile: Set<string>;
        }>();

        for (const [svId, profile] of profiles) {
            profileSets.set(svId, {
                resource_touches: new Set(profile.resource_touches),
                db_reads: new Set(profile.db_reads),
                db_writes: new Set(profile.db_writes),
                network_calls: new Set(profile.network_calls),
                cache_ops: new Set(profile.cache_ops),
                file_io: new Set(profile.file_io),
                auth_operations: new Set(profile.auth_operations),
                state_mutation_profile: new Set(profile.state_mutation_profile),
                transaction_profile: new Set(profile.transaction_profile),
            });
        }

        // Kahn's algorithm: start with nodes that have no profiled callees (in-degree 0)
        const queue: string[] = [];
        let queueIdx = 0;
        for (const [svId, degree] of inDegree) {
            if (degree === 0 && profiles.has(svId)) queue.push(svId);
        }

        const processed = new Set<string>();
        while (queueIdx < queue.length) {
            const calleeId = queue[queueIdx++]!;
            if (processed.has(calleeId)) continue;
            processed.add(calleeId);

            const calleeProfile = profiles.get(calleeId);
            if (!calleeProfile) continue;
            const calleeSets = profileSets.get(calleeId);
            if (!calleeSets) continue;

            // Propagate this callee's effects to all its callers
            const callers = reverseGraph.get(calleeId) || [];
            for (const callerId of callers) {
                const callerProfile = profiles.get(callerId);
                if (!callerProfile) continue;
                const callerSets = profileSets.get(callerId);
                if (!callerSets) continue;

                let changed = false;

                // Escalate purity
                const callerLevel = purityOrder[callerProfile.purity_class];
                const calleeLevel = purityOrder[calleeProfile.purity_class];
                if (calleeLevel > callerLevel) {
                    callerProfile.purity_class = calleeProfile.purity_class;
                    changed = true;
                }

                // Merge resources with O(1) Set lookups
                if (mergeUnique(callerProfile.resource_touches, calleeProfile.resource_touches, callerSets.resource_touches)) changed = true;
                if (mergeUnique(callerProfile.db_reads, calleeProfile.db_reads, callerSets.db_reads)) changed = true;
                if (mergeUnique(callerProfile.db_writes, calleeProfile.db_writes, callerSets.db_writes)) changed = true;
                if (mergeUnique(callerProfile.network_calls, calleeProfile.network_calls, callerSets.network_calls)) changed = true;
                if (mergeUnique(callerProfile.cache_ops, calleeProfile.cache_ops, callerSets.cache_ops)) changed = true;
                if (mergeUnique(callerProfile.file_io, calleeProfile.file_io, callerSets.file_io)) changed = true;
                if (mergeUnique(callerProfile.auth_operations, calleeProfile.auth_operations, callerSets.auth_operations)) changed = true;
                if (mergeUnique(callerProfile.state_mutation_profile, calleeProfile.state_mutation_profile, callerSets.state_mutation_profile)) changed = true;
                if (mergeUnique(callerProfile.transaction_profile, calleeProfile.transaction_profile, callerSets.transaction_profile)) changed = true;

                if (changed) changedSvIds.add(callerId);

                // Decrement caller's in-degree; when 0, all its callees are processed
                const newDegree = (inDegree.get(callerId) || 1) - 1;
                inDegree.set(callerId, newDegree);
                if (newDegree <= 0) queue.push(callerId);
            }
        }

        // ── Cycle recovery ──────────────────────────────────────────────
        // Nodes involved in cycles (including self-recursive functions) never
        // reach in-degree 0, so Kahn's algorithm silently skips them. Detect
        // unprocessed nodes, cluster them via BFS on the restricted subgraph,
        // then compute the union of all effects within each cluster and assign
        // the most impure purity_class to every member.
        const unprocessed = Array.from(profiles.keys()).filter(svId => !processed.has(svId) && inDegree.has(svId));
        if (unprocessed.length > 0) {
            log.debug('Behavioral propagation: recovering cycle members', { count: unprocessed.length });

            // Discover connected cycle clusters via BFS on the call graph
            // restricted to unprocessed nodes
            const unprocessedSet = new Set(unprocessed);
            const visited = new Set<string>();

            for (const startNode of unprocessed) {
                if (visited.has(startNode)) continue;

                // BFS to find all nodes in this cycle cluster
                const cluster: string[] = [];
                const bfsQueue: string[] = [startNode];
                let bfsIdx = 0;
                while (bfsIdx < bfsQueue.length) {
                    const node = bfsQueue[bfsIdx++]!;
                    if (visited.has(node)) continue;
                    visited.add(node);
                    cluster.push(node);

                    // Follow forward edges (callees) restricted to unprocessed
                    const callees = callGraph.get(node) || [];
                    for (const c of callees) {
                        if (unprocessedSet.has(c) && !visited.has(c)) bfsQueue.push(c);
                    }
                    // Follow reverse edges (callers) restricted to unprocessed
                    const callers = reverseGraph.get(node) || [];
                    for (const c of callers) {
                        if (unprocessedSet.has(c) && !visited.has(c)) bfsQueue.push(c);
                    }
                }

                // Compute the union of all effects across the cluster
                const clusterResourceTouches = new Set<string>();
                const clusterDbReads = new Set<string>();
                const clusterDbWrites = new Set<string>();
                const clusterNetworkCalls = new Set<string>();
                const clusterCacheOps = new Set<string>();
                const clusterFileIo = new Set<string>();
                const clusterAuthOps = new Set<string>();
                const clusterStateMutation = new Set<string>();
                const clusterTransaction = new Set<string>();
                let clusterMaxPurity: PurityClass = 'pure';

                for (const nodeId of cluster) {
                    const p = profiles.get(nodeId);
                    if (!p) continue;
                    for (const v of p.resource_touches) clusterResourceTouches.add(v);
                    for (const v of p.db_reads) clusterDbReads.add(v);
                    for (const v of p.db_writes) clusterDbWrites.add(v);
                    for (const v of p.network_calls) clusterNetworkCalls.add(v);
                    for (const v of p.cache_ops) clusterCacheOps.add(v);
                    for (const v of p.file_io) clusterFileIo.add(v);
                    for (const v of p.auth_operations) clusterAuthOps.add(v);
                    for (const v of p.state_mutation_profile) clusterStateMutation.add(v);
                    for (const v of p.transaction_profile) clusterTransaction.add(v);
                    if (purityOrder[p.purity_class] > purityOrder[clusterMaxPurity]) {
                        clusterMaxPurity = p.purity_class;
                    }
                }

                // Assign the union to every member of the cluster
                for (const nodeId of cluster) {
                    const p = profiles.get(nodeId);
                    if (!p) continue;
                    const s = profileSets.get(nodeId);
                    if (!s) continue;

                    let changed = false;
                    if (purityOrder[clusterMaxPurity] > purityOrder[p.purity_class]) {
                        p.purity_class = clusterMaxPurity;
                        changed = true;
                    }
                    if (mergeUnique(p.resource_touches, Array.from(clusterResourceTouches), s.resource_touches)) changed = true;
                    if (mergeUnique(p.db_reads, Array.from(clusterDbReads), s.db_reads)) changed = true;
                    if (mergeUnique(p.db_writes, Array.from(clusterDbWrites), s.db_writes)) changed = true;
                    if (mergeUnique(p.network_calls, Array.from(clusterNetworkCalls), s.network_calls)) changed = true;
                    if (mergeUnique(p.cache_ops, Array.from(clusterCacheOps), s.cache_ops)) changed = true;
                    if (mergeUnique(p.file_io, Array.from(clusterFileIo), s.file_io)) changed = true;
                    if (mergeUnique(p.auth_operations, Array.from(clusterAuthOps), s.auth_operations)) changed = true;
                    if (mergeUnique(p.state_mutation_profile, Array.from(clusterStateMutation), s.state_mutation_profile)) changed = true;
                    if (mergeUnique(p.transaction_profile, Array.from(clusterTransaction), s.transaction_profile)) changed = true;

                    if (changed) changedSvIds.add(nodeId);
                }
            }
        }

        // Persist only changed profiles back to DB
        const statements: { text: string; params: unknown[] }[] = [];
        for (const svId of changedSvIds) {
            const profile = profiles.get(svId);
            if (!profile) continue;
            statements.push({
                text: `UPDATE behavioral_profiles SET
                    purity_class = $1,
                    resource_touches = $2,
                    db_reads = $3,
                    db_writes = $4,
                    network_calls = $5,
                    cache_ops = $6,
                    file_io = $7,
                    auth_operations = $8,
                    state_mutation_profile = $9,
                    transaction_profile = $10
                WHERE symbol_version_id = $11`,
                params: [
                    profile.purity_class,
                    profile.resource_touches,
                    profile.db_reads,
                    profile.db_writes,
                    profile.network_calls,
                    profile.cache_ops,
                    profile.file_io,
                    profile.auth_operations,
                    profile.state_mutation_profile,
                    profile.transaction_profile,
                    svId,
                ],
            });
        }

        if (statements.length > 0) {
            await db.batchInsert(statements);
        }

        timer({ profiles_propagated: changedSvIds.size });
        return changedSvIds.size;
    }

    /**
     * Compare two behavioral profiles for semantic equivalence.
     */
    public compareBehavior(
        before: BehavioralProfile,
        after: BehavioralProfile
    ): {
        purityChanged: boolean;
        purityDirection: 'escalated' | 'deescalated' | 'unchanged';
        newResourceTouches: string[];
        removedResourceTouches: string[];
        sideEffectsChanged: boolean;
    } {
        const purityOrder: Record<PurityClass, number> = {
            pure: 0, read_only: 1, read_write: 2, side_effecting: 3,
        };

        const beforeLevel = purityOrder[before.purity_class];
        const afterLevel = purityOrder[after.purity_class];

        const beforeResources = new Set(before.resource_touches);
        const afterResources = new Set(after.resource_touches);
        const newResources = after.resource_touches.filter(r => !beforeResources.has(r));
        const removedResources = before.resource_touches.filter(r => !afterResources.has(r));

        const arraysEqual = (a: string[], b: string[]): boolean => {
            if (a.length !== b.length) return false;
            const sortedA = [...a].sort();
            const sortedB = [...b].sort();
            return sortedA.every((v, i) => v === sortedB[i]);
        };
        const sideEffectsChanged =
            !arraysEqual(before.network_calls, after.network_calls) ||
            !arraysEqual(before.db_writes, after.db_writes) ||
            !arraysEqual(before.file_io, after.file_io) ||
            !arraysEqual(before.state_mutation_profile, after.state_mutation_profile) ||
            !arraysEqual(before.auth_operations, after.auth_operations) ||
            !arraysEqual(before.transaction_profile, after.transaction_profile);

        return {
            purityChanged: beforeLevel !== afterLevel,
            purityDirection: afterLevel > beforeLevel ? 'escalated'
                : afterLevel < beforeLevel ? 'deescalated'
                : 'unchanged',
            newResourceTouches: newResources,
            removedResourceTouches: removedResources,
            sideEffectsChanged,
        };
    }
}

export const behavioralEngine = new BehavioralEngine();
