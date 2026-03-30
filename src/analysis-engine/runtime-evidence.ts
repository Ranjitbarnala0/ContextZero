/**
 * ContextZero — Runtime Evidence Engine
 *
 * Ingests runtime trace data (test executions, dev runs, CI traces, production
 * samples) and fuses it with the static analysis graph to reduce uncertainty
 * and improve dispatch resolution.
 *
 * Six responsibilities:
 *   1. Trace Pack Ingestion — accept structured trace packs, persist raw data
 *   2. Symbol Resolution    — map runtime frames to symbol lineage IDs
 *   3. Edge Merging         — merge observed edges into the structural graph
 *   4. Uncertainty Reduction— confirm static inferences, lower uncertainty flags
 *   5. Dynamic Route Reg.   — capture framework-specific runtime bindings
 *   6. Provenance Tracking  — tag every relation with its evidence source
 *
 * Provenance taxonomy:
 *   static_exact        — compiler/type-system guaranteed
 *   static_inferred     — heuristic/pattern-based
 *   runtime_observed    — seen in actual execution
 *   framework_declared  — from framework metadata (decorators, ORM, etc.)
 *   developer_asserted  — manually annotated by developer
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { coreDataService, type SymbolVersionRow } from '../db-driver/core_data';
import { Logger } from '../logger';
import type {
    TracePack, TraceCallEdge, TraceDynamicRoute,
    TraceObservedType, TraceFrameworkEvent,
} from '../types';

const log = new Logger('runtime-evidence');

// ─── Runtime Frame (parsed from stack traces / profiler output) ────────────

export interface RuntimeFrame {
    function_name: string;     // may be mangled, anonymous, or generated
    file_path?: string;        // relative or absolute path
    line_number?: number;
    column_number?: number;
    is_anonymous?: boolean;
    module_name?: string;      // for languages with module systems
}

// ─── Extended result types (richer than the canonical ones in types.ts) ────

export interface TraceIngestionResultExtended {
    trace_id: string;
    call_edges_count: number;
    dynamic_routes_count: number;
    observed_types_count: number;
    framework_events_count: number;
    stored: boolean;
    validation_errors: string[];
}

export interface ObservedEdgeSummary {
    counterpart_symbol_version_id: string | null;
    receiver_type: string | null;
    call_count: number;
    confidence: number;
    trace_source: string;
}

export interface RuntimeEvidenceExtended {
    symbol_version_id: string;
    observed_as_caller: ObservedEdgeSummary[];
    observed_as_callee: ObservedEdgeSummary[];
    observed_types: TraceObservedType[];
    dynamic_routes: TraceDynamicRoute[];
    total_observations: number;
    first_observed: Date | null;
    last_observed: Date | null;
    confidence_boost: number;
}

// ─── Internal types ────────────────────────────────────────────────────────

interface SymbolLookupIndex {
    byStableKey: Map<string, string>;
    byCanonical: Map<string, string>;
    byFileLine: Map<string, string>;   // "file_path:start_line" -> svId
    byFileName: Map<string, string>;   // "file_path::function_name" -> svId
    rows: SymbolVersionRow[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const VALID_TRACE_SOURCES = new Set(['test_execution', 'dev_run', 'ci_trace', 'production_sample']);
const MAX_CALL_EDGES_PER_TRACE = 50_000;
const MAX_DYNAMIC_ROUTES_PER_TRACE = 5_000;
const MAX_OBSERVED_TYPES_PER_TRACE = 10_000;
const MAX_FRAMEWORK_EVENTS_PER_TRACE = 10_000;
const BATCH_CHUNK_SIZE = 2_000;

/** Confidence floor applied when we have a partial frame match */
const PARTIAL_MATCH_CONFIDENCE = 0.6;
/** Confidence for file+line match */
const FILE_LINE_MATCH_CONFIDENCE = 0.85;
/** Boost applied to static edges confirmed by runtime evidence */
const RUNTIME_CONFIRMATION_BOOST = 0.15;
/** Minimum confidence for runtime-only edges injected into the structural graph */
const RUNTIME_EDGE_BASE_CONFIDENCE = 0.85;
/** Confidence ceiling — never exceed 1.0 */
const CONFIDENCE_CAP = 1.0;

// ─── Engine ────────────────────────────────────────────────────────────────

export class RuntimeEvidenceEngine {

    // ──────────────────────────────────────────────────────────
    // 1. TRACE PACK INGESTION
    // ──────────────────────────────────────────────────────────

    /**
     * Ingest a trace pack: validate, persist raw data to runtime_traces.
     * Does NOT resolve symbols or merge edges — that happens in processTraces().
     */
    async ingestTrace(
        repoId: string,
        snapshotId: string,
        tracePack: TracePack,
    ): Promise<TraceIngestionResultExtended> {
        const timer = log.startTimer('ingestTrace', {
            repoId,
            snapshotId,
            source: tracePack.source,
        });

        const validationErrors = this.validateTracePack(tracePack);

        if (validationErrors.length > 0) {
            log.warn('Trace pack has validation errors', {
                repoId,
                snapshotId,
                errors: validationErrors,
            });
        }

        // Truncate oversized payloads rather than rejecting the entire trace
        // Defensive: coerce to arrays in case upstream sends undefined for optional fields
        const callEdges = (tracePack.call_edges ?? []).slice(0, MAX_CALL_EDGES_PER_TRACE);
        const dynamicRoutes = (tracePack.dynamic_routes ?? []).slice(0, MAX_DYNAMIC_ROUTES_PER_TRACE);
        const observedTypes = (tracePack.observed_types ?? []).slice(0, MAX_OBSERVED_TYPES_PER_TRACE);
        const frameworkEvents = (tracePack.framework_events ?? []).slice(0, MAX_FRAMEWORK_EVENTS_PER_TRACE);

        const traceId = uuidv4();

        // Coerce timestamp safely
        const traceTimestamp = tracePack.timestamp instanceof Date && !isNaN(tracePack.timestamp.getTime())
            ? tracePack.timestamp
            : new Date();

        try {
            await db.query(`
                INSERT INTO runtime_traces
                    (trace_id, repo_id, snapshot_id, trace_source, trace_timestamp,
                     call_edges, dynamic_routes, observed_types, framework_events,
                     is_processed, edges_resolved)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, 0)
            `, [
                traceId, repoId, snapshotId,
                tracePack.source, traceTimestamp,
                JSON.stringify(callEdges),
                JSON.stringify(dynamicRoutes),
                JSON.stringify(observedTypes),
                JSON.stringify(frameworkEvents),
            ]);

            const result: TraceIngestionResultExtended = {
                trace_id: traceId,
                call_edges_count: callEdges.length,
                dynamic_routes_count: dynamicRoutes.length,
                observed_types_count: observedTypes.length,
                framework_events_count: frameworkEvents.length,
                stored: true,
                validation_errors: validationErrors,
            };

            timer({
                trace_id: traceId,
                call_edges: callEdges.length,
                dynamic_routes: dynamicRoutes.length,
            });

            return result;
        } catch (err) {
            log.error('Failed to ingest trace pack', err instanceof Error ? err : new Error(String(err)), {
                repoId,
                snapshotId,
            });
            return {
                trace_id: traceId,
                call_edges_count: 0,
                dynamic_routes_count: 0,
                observed_types_count: 0,
                framework_events_count: 0,
                stored: false,
                validation_errors: [
                    ...validationErrors,
                    `Ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
                ],
            };
        }
    }

    /**
     * Validate a trace pack for structural correctness.
     * Returns an array of validation error strings (empty = valid).
     */
    private validateTracePack(tracePack: TracePack): string[] {
        const errors: string[] = [];

        if (!tracePack) {
            return ['Trace pack is null or undefined'];
        }

        if (!VALID_TRACE_SOURCES.has(tracePack.source)) {
            errors.push(`Invalid trace source: '${tracePack.source}'. Valid sources: test_execution, dev_run, ci_trace, production_sample`);
        }

        if (!Array.isArray(tracePack.call_edges)) {
            errors.push('call_edges must be an array');
        } else {
            const checkLimit = Math.min(tracePack.call_edges.length, 5);
            for (let i = 0; i < checkLimit; i++) {
                const edge = tracePack.call_edges[i];
                if (edge === undefined) continue;
                if (!edge.caller_key || typeof edge.caller_key !== 'string') {
                    errors.push(`call_edges[${i}].caller_key is missing or not a string`);
                }
                if (!edge.callee_key || typeof edge.callee_key !== 'string') {
                    errors.push(`call_edges[${i}].callee_key is missing or not a string`);
                }
                if (typeof edge.call_count !== 'number' || edge.call_count < 0) {
                    errors.push(`call_edges[${i}].call_count must be a non-negative number`);
                }
            }
            if (tracePack.call_edges.length > MAX_CALL_EDGES_PER_TRACE) {
                errors.push(`call_edges exceeds maximum of ${MAX_CALL_EDGES_PER_TRACE} (got ${tracePack.call_edges.length}), will be truncated`);
            }
        }

        if (tracePack.dynamic_routes != null && !Array.isArray(tracePack.dynamic_routes)) {
            errors.push('dynamic_routes must be an array if provided');
        } else if (Array.isArray(tracePack.dynamic_routes)) {
            const checkLimit = Math.min(tracePack.dynamic_routes.length, 5);
            for (let i = 0; i < checkLimit; i++) {
                const route = tracePack.dynamic_routes[i];
                if (route === undefined) continue;
                if (!route.route || typeof route.route !== 'string') {
                    errors.push(`dynamic_routes[${i}].route is missing or not a string`);
                }
                if (!route.handler_key || typeof route.handler_key !== 'string') {
                    errors.push(`dynamic_routes[${i}].handler_key is missing or not a string`);
                }
            }
        }

        if (tracePack.observed_types != null && !Array.isArray(tracePack.observed_types)) {
            errors.push('observed_types must be an array if provided');
        }

        if (tracePack.framework_events != null && !Array.isArray(tracePack.framework_events)) {
            errors.push('framework_events must be an array if provided');
        }

        return errors;
    }

    // ──────────────────────────────────────────────────────────
    // 2. PROCESS TRACES — resolve symbols, create observed edges
    // ──────────────────────────────────────────────────────────

    /**
     * Process all unprocessed traces for a given repo+snapshot.
     * For each trace: resolve frames to symbols, create observed edges,
     * register dynamic routes, and mark the trace as processed.
     *
     * Returns total number of edges resolved across all traces.
     */
    async processTraces(repoId: string, snapshotId: string): Promise<number> {
        const timer = log.startTimer('processTraces', { repoId, snapshotId });

        // Fetch unprocessed traces
        const traceResult = await db.query(`
            SELECT trace_id, call_edges, dynamic_routes, observed_types, framework_events, trace_source
            FROM runtime_traces
            WHERE repo_id = $1 AND snapshot_id = $2 AND is_processed = FALSE
            ORDER BY trace_timestamp ASC
        `, [repoId, snapshotId]);

        if (traceResult.rowCount === 0) {
            timer({ traces_processed: 0, edges_resolved: 0 });
            return 0;
        }

        // Build symbol lookup index once for all traces in this snapshot
        const lookupIndex = await this.buildSymbolLookupIndex(snapshotId);

        let totalEdgesResolved = 0;

        for (const row of traceResult.rows as {
            trace_id: string;
            call_edges: TraceCallEdge[];
            dynamic_routes: TraceDynamicRoute[];
            observed_types: TraceObservedType[];
            framework_events: TraceFrameworkEvent[];
            trace_source: string;
        }[]) {
            try {
                const edgesResolved = await this.processSingleTrace(
                    row.trace_id,
                    snapshotId,
                    row.call_edges || [],
                    row.dynamic_routes || [],
                    row.observed_types || [],
                    row.framework_events || [],
                    row.trace_source,
                    lookupIndex,
                );

                // Mark trace as processed
                await db.query(`
                    UPDATE runtime_traces
                    SET is_processed = TRUE, edges_resolved = $1
                    WHERE trace_id = $2
                `, [edgesResolved, row.trace_id]);

                totalEdgesResolved += edgesResolved;
            } catch (err) {
                log.error('Failed to process trace', err instanceof Error ? err : new Error(String(err)), {
                    trace_id: row.trace_id,
                });
                // Mark as processed to avoid infinite retry loops; the error is logged
                await db.query(`
                    UPDATE runtime_traces
                    SET is_processed = TRUE, edges_resolved = 0
                    WHERE trace_id = $1
                `, [row.trace_id]);
            }
        }

        timer({
            traces_processed: traceResult.rowCount,
            edges_resolved: totalEdgesResolved,
        });

        return totalEdgesResolved;
    }

    /**
     * Process a single trace: resolve call edges, persist observed edges,
     * handle dynamic routes and framework events.
     */
    private async processSingleTrace(
        traceId: string,
        snapshotId: string,
        callEdges: TraceCallEdge[],
        dynamicRoutes: TraceDynamicRoute[],
        observedTypes: TraceObservedType[],
        frameworkEvents: TraceFrameworkEvent[],
        _traceSource: string,
        lookupIndex: SymbolLookupIndex,
    ): Promise<number> {
        let edgesResolved = 0;

        // ── Resolve call edges ──
        const observedEdgeStatements: { text: string; params: unknown[] }[] = [];

        for (const edge of callEdges) {
            if (!edge.caller_key || !edge.callee_key) continue;

            const callerSvId = this.resolveKeyToSymbolVersion(edge.caller_key, lookupIndex);
            const calleeSvId = this.resolveKeyToSymbolVersion(edge.callee_key, lookupIndex);

            // We require at least one side to be resolved to create a useful edge
            if (!callerSvId && !calleeSvId) continue;

            const callCount = Math.max(1, Math.floor(edge.call_count || 1));
            const confidence = this.computeEdgeConfidence(callerSvId, calleeSvId, callCount);

            observedEdgeStatements.push({
                text: `INSERT INTO runtime_observed_edges
                    (observed_edge_id, trace_id, snapshot_id,
                     caller_symbol_version_id, callee_symbol_version_id,
                     receiver_type, call_count, confidence, first_observed, last_observed)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                ON CONFLICT (trace_id, caller_symbol_version_id, callee_symbol_version_id)
                DO UPDATE SET
                    call_count = runtime_observed_edges.call_count + EXCLUDED.call_count,
                    confidence = GREATEST(runtime_observed_edges.confidence, EXCLUDED.confidence),
                    last_observed = NOW()`,
                params: [
                    uuidv4(), traceId, snapshotId,
                    callerSvId, calleeSvId,
                    edge.receiver_type || null,
                    callCount, confidence,
                ],
            });

            edgesResolved++;
        }

        // ── Persist observed edges in chunks ──
        if (observedEdgeStatements.length > 0) {
            for (let i = 0; i < observedEdgeStatements.length; i += BATCH_CHUNK_SIZE) {
                const chunk = observedEdgeStatements.slice(i, i + BATCH_CHUNK_SIZE);
                await db.batchInsert(chunk);
            }
        }

        // ── Process dynamic routes ──
        await this.processDynamicRoutes(snapshotId, dynamicRoutes, lookupIndex);

        // ── Process observed types -> update dispatch edges ──
        await this.processObservedTypes(snapshotId, observedTypes);

        // ── Process framework events ──
        await this.processFrameworkEvents(snapshotId, frameworkEvents, lookupIndex);

        return edgesResolved;
    }

    // ──────────────────────────────────────────────────────────
    // 3. SYMBOL RESOLUTION
    // ──────────────────────────────────────────────────────────

    /**
     * Build a multi-strategy lookup index for symbol resolution.
     * Called once per snapshot, then reused across all traces.
     */
    private async buildSymbolLookupIndex(snapshotId: string): Promise<SymbolLookupIndex> {
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);

        const byStableKey = new Map<string, string>();
        const byCanonical = new Map<string, string>();
        const byFileLine = new Map<string, string>();
        const byFileName = new Map<string, string>();

        for (const sv of svRows) {
            byStableKey.set(sv.stable_key, sv.symbol_version_id);
            byCanonical.set(sv.canonical_name, sv.symbol_version_id);

            // Index by file_path:start_line for stack-frame resolution
            if (sv.file_path && sv.range_start_line) {
                byFileLine.set(
                    `${this.normalizePath(sv.file_path)}:${sv.range_start_line}`,
                    sv.symbol_version_id,
                );
            }

            // Index by file_path::name for fuzzy resolution
            if (sv.file_path && sv.canonical_name) {
                const simpleName = this.extractSimpleName(sv.canonical_name);
                byFileName.set(
                    `${this.normalizePath(sv.file_path)}::${simpleName}`,
                    sv.symbol_version_id,
                );
            }
        }

        return { byStableKey, byCanonical, byFileLine, byFileName, rows: svRows };
    }

    /**
     * Resolve a single runtime frame to a symbol_version_id.
     * Uses a multi-strategy cascade:
     *   1. Exact stable_key match
     *   2. Canonical name match
     *   3. File + line number match
     *   4. File + function name match (fuzzy)
     *   5. Demangled / cleaned name match
     *
     * Returns null if no match above confidence threshold.
     */
    async resolveFrame(
        _repoId: string,
        snapshotId: string,
        frame: RuntimeFrame,
    ): Promise<string | null> {
        const lookupIndex = await this.buildSymbolLookupIndex(snapshotId);
        return this.resolveFrameWithIndex(frame, lookupIndex);
    }

    /**
     * Internal frame resolution against a pre-built index.
     */
    private resolveFrameWithIndex(
        frame: RuntimeFrame,
        lookupIndex: SymbolLookupIndex,
    ): string | null {
        if (!frame || !frame.function_name) return null;

        // Strategy 1: Try as stable_key directly
        const byKey = lookupIndex.byStableKey.get(frame.function_name);
        if (byKey) return byKey;

        // Strategy 2: Try as canonical_name
        const byCanonical = lookupIndex.byCanonical.get(frame.function_name);
        if (byCanonical) return byCanonical;

        // Strategy 3: File + line number
        if (frame.file_path && frame.line_number) {
            const normalizedPath = this.normalizePath(frame.file_path);
            const byFileLine = lookupIndex.byFileLine.get(
                `${normalizedPath}:${frame.line_number}`,
            );
            if (byFileLine) return byFileLine;

            // Try nearby lines (off-by-one from source maps, instrumentation)
            const deltas = [-1, 1, -2, 2];
            for (const delta of deltas) {
                const nearby = lookupIndex.byFileLine.get(
                    `${normalizedPath}:${frame.line_number + delta}`,
                );
                if (nearby) return nearby;
            }
        }

        // Strategy 4: File + function name (fuzzy)
        if (frame.file_path) {
            const normalizedPath = this.normalizePath(frame.file_path);
            const simpleName = this.extractSimpleName(frame.function_name);
            const byFileName = lookupIndex.byFileName.get(
                `${normalizedPath}::${simpleName}`,
            );
            if (byFileName) return byFileName;
        }

        // Strategy 5: Demangle and retry canonical match
        const demangled = this.demangleName(frame.function_name);
        if (demangled !== frame.function_name) {
            const byDemangled = lookupIndex.byCanonical.get(demangled);
            if (byDemangled) return byDemangled;
        }

        // Strategy 6: Partial name match across all canonical names
        // Only attempt this for non-anonymous functions to avoid false positives
        // Capped at 1000 entries to avoid O(N*M) blowup on large codebases
        if (!frame.is_anonymous && frame.function_name.length >= 4) {
            const cleaned = this.extractSimpleName(frame.function_name).toLowerCase();
            if (cleaned.length >= 4) {
                let scanned = 0;
                for (const [canonical, svId] of lookupIndex.byCanonical) {
                    if (++scanned > 1000) break;
                    const canonicalSimple = this.extractSimpleName(canonical).toLowerCase();
                    if (canonicalSimple === cleaned) {
                        return svId;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Resolve a trace key (caller_key / callee_key) to a symbol_version_id.
     * Trace keys can be in several formats:
     *   - stable_key:  "src/api/handler.ts::handleRequest"
     *   - canonical:   "handleRequest"
     *   - file:line:   "src/api/handler.ts:42"
     *   - qualified:   "Module.Class.method"
     */
    private resolveKeyToSymbolVersion(
        key: string,
        lookupIndex: SymbolLookupIndex,
    ): string | null {
        if (!key || typeof key !== 'string') return null;

        // Direct lookup first (covers stable_key and canonical_name)
        const direct = lookupIndex.byStableKey.get(key)
            || lookupIndex.byCanonical.get(key);
        if (direct) return direct;

        // Parse file:line format
        const fileLineMatch = key.match(/^(.+):(\d+)$/);
        if (fileLineMatch) {
            const filePath = fileLineMatch[1];
            const lineNum = fileLineMatch[2];
            if (filePath && lineNum) {
                const frame: RuntimeFrame = {
                    function_name: key,
                    file_path: filePath,
                    line_number: parseInt(lineNum, 10),
                };
                return this.resolveFrameWithIndex(frame, lookupIndex);
            }
        }

        // Parse file::name format (our own stable_key format)
        const fileNameMatch = key.match(/^(.+?)::(.+)$/);
        if (fileNameMatch) {
            const filePart = fileNameMatch[1];
            const namePart = fileNameMatch[2];
            if (filePart && namePart) {
                const normalizedPath = this.normalizePath(filePart);
                const simpleName = this.extractSimpleName(namePart);
                const byFileName = lookupIndex.byFileName.get(
                    `${normalizedPath}::${simpleName}`,
                );
                if (byFileName) return byFileName;

                // Also try as canonical name (the part after ::)
                const byCan = lookupIndex.byCanonical.get(namePart);
                if (byCan) return byCan;
            }
        }

        // Try demangled
        const demangled = this.demangleName(key);
        if (demangled !== key) {
            const byDemangled = lookupIndex.byCanonical.get(demangled);
            if (byDemangled) return byDemangled;
        }

        // Last resort: simple name match
        // Capped at 1000 entries to avoid O(N*M) blowup on large codebases
        const simpleName = this.extractSimpleName(key).toLowerCase();
        if (simpleName.length >= 4) {
            let scanned = 0;
            for (const [canonical, svId] of lookupIndex.byCanonical) {
                if (++scanned > 1000) break;
                const canonicalSimple = this.extractSimpleName(canonical).toLowerCase();
                if (canonicalSimple === simpleName) {
                    return svId;
                }
            }
        }

        return null;
    }

    // ──────────────────────────────────────────────────────────
    // 4. EDGE MERGING
    // ──────────────────────────────────────────────────────────

    /**
     * Merge all resolved observed edges into the structural graph:
     *   - Boost confidence of matching static edges
     *   - Create new runtime_observed edges for calls not seen statically
     *   - Update dispatch_edges with runtime-confirmed targets
     *
     * Returns the number of structural relations affected (boosted or created).
     */
    async mergeObservedEdges(snapshotId: string): Promise<number> {
        const timer = log.startTimer('mergeObservedEdges', { snapshotId });

        // Fetch all resolved observed edges (both sides non-null)
        const observedResult = await db.query(`
            SELECT caller_symbol_version_id, callee_symbol_version_id,
                   receiver_type, SUM(call_count) as total_calls,
                   MAX(confidence) as max_confidence
            FROM runtime_observed_edges
            WHERE snapshot_id = $1
              AND caller_symbol_version_id IS NOT NULL
              AND callee_symbol_version_id IS NOT NULL
            GROUP BY caller_symbol_version_id, callee_symbol_version_id, receiver_type
        `, [snapshotId]);

        if (observedResult.rowCount === 0) {
            timer({ affected: 0 });
            return 0;
        }

        let affected = 0;
        const statements: { text: string; params: unknown[] }[] = [];

        // Batch-load ALL existing static 'calls' edges for this snapshot's symbols
        // to avoid N+1 queries inside the loop below.
        const staticEdgesResult = await db.query(`
            SELECT relation_id, src_symbol_version_id, dst_symbol_version_id, confidence, provenance
            FROM structural_relations
            WHERE relation_type = 'calls'
              AND src_symbol_version_id = ANY(
                  SELECT DISTINCT caller_symbol_version_id FROM runtime_observed_edges
                  WHERE snapshot_id = $1 AND caller_symbol_version_id IS NOT NULL
              )
        `, [snapshotId]);

        // Build lookup map: "caller::callee" -> { relation_id, confidence, provenance }
        const staticEdgeMap = new Map<string, { relation_id: string; confidence: number; provenance: string }>();
        for (const row of staticEdgesResult.rows as { relation_id: string; src_symbol_version_id: string; dst_symbol_version_id: string; confidence: number; provenance: string }[]) {
            staticEdgeMap.set(`${row.src_symbol_version_id}::${row.dst_symbol_version_id}`, row);
        }

        for (const row of observedResult.rows as {
            caller_symbol_version_id: string;
            callee_symbol_version_id: string;
            receiver_type: string | null;
            total_calls: string;
            max_confidence: number;
        }[]) {
            const callerSvId = row.caller_symbol_version_id;
            const calleeSvId = row.callee_symbol_version_id;
            const totalCalls = parseInt(row.total_calls, 10);

            // Observation-count-scaled confidence: more observations = higher trust
            const observationConfidence = Math.min(
                CONFIDENCE_CAP,
                RUNTIME_EDGE_BASE_CONFIDENCE + Math.log10(Math.max(1, totalCalls)) * 0.05,
            );

            // Check if a static edge already exists (in-memory lookup)
            const existing = staticEdgeMap.get(`${callerSvId}::${calleeSvId}`);

            if (existing) {
                const boostedConfidence = Math.min(
                    CONFIDENCE_CAP,
                    existing.confidence + RUNTIME_CONFIRMATION_BOOST,
                );

                // Only update if we actually improve confidence or upgrade provenance
                if (boostedConfidence > existing.confidence || existing.provenance === 'static_inferred') {
                    statements.push({
                        text: `UPDATE structural_relations
                               SET confidence = $1, provenance = 'runtime_observed', source = 'runtime_trace'
                               WHERE relation_id = $2`,
                        params: [boostedConfidence, existing.relation_id],
                    });
                    affected++;
                }
            } else {
                // Create new runtime-observed edge
                statements.push({
                    text: `INSERT INTO structural_relations
                        (relation_id, src_symbol_version_id, dst_symbol_version_id,
                         relation_type, strength, source, confidence, provenance)
                    VALUES ($1, $2, $3, 'calls', $4, 'runtime_trace', $5, 'runtime_observed')
                    ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type)
                    DO UPDATE SET
                        confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence),
                        provenance = 'runtime_observed',
                        source = 'runtime_trace'`,
                    params: [
                        uuidv4(), callerSvId, calleeSvId,
                        1.0, observationConfidence,
                    ],
                });
                affected++;
            }

            // If we have a receiver_type, also update any matching dispatch_edges
            if (row.receiver_type) {
                statements.push({
                    text: `UPDATE dispatch_edges
                           SET confidence = GREATEST(confidence, $1),
                               resolution_method = 'runtime_observed',
                               receiver_types = CASE
                                   WHEN $2 = ANY(receiver_types) THEN receiver_types
                                   ELSE array_append(receiver_types, $2)
                               END,
                               resolved_symbol_version_ids = CASE
                                   WHEN $3 = ANY(resolved_symbol_version_ids) THEN resolved_symbol_version_ids
                                   ELSE array_append(resolved_symbol_version_ids, $3)
                               END
                           WHERE caller_symbol_version_id = $4
                             AND snapshot_id = $5
                             AND (resolution_method = 'unresolved' OR confidence < $1)`,
                    params: [
                        observationConfidence,
                        row.receiver_type,
                        calleeSvId,
                        callerSvId,
                        snapshotId,
                    ],
                });
            }
        }

        // Batch write all changes
        if (statements.length > 0) {
            for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
                const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
                await db.batchInsert(chunk);
            }
        }

        timer({ affected, observed_edges: observedResult.rowCount });
        return affected;
    }

    // ──────────────────────────────────────────────────────────
    // 5. UNCERTAINTY REDUCTION
    // ──────────────────────────────────────────────────────────

    /**
     * Reduce uncertainty on symbols that have runtime evidence:
     *   - Remove 'dynamic_dispatch' flag if runtime confirmed target
     *   - Remove 'runtime_only_behavior' if runtime trace observed
     *   - Remove 'type_inference_failure' if observed types available
     *   - Boost confidence on dispatch_edges confirmed at runtime
     *
     * Returns the number of symbol_versions whose uncertainty was reduced.
     */
    async reduceUncertainty(snapshotId: string): Promise<number> {
        const timer = log.startTimer('reduceUncertainty', { snapshotId });

        // Step 1: Find symbols with runtime evidence
        const symbolsWithEvidence = await db.query(`
            SELECT DISTINCT sv.symbol_version_id, sv.uncertainty_flags
            FROM symbol_versions sv
            WHERE sv.snapshot_id = $1
              AND array_length(sv.uncertainty_flags, 1) > 0
              AND (
                  EXISTS (
                      SELECT 1 FROM runtime_observed_edges roe
                      WHERE roe.snapshot_id = $1
                        AND (roe.caller_symbol_version_id = sv.symbol_version_id
                             OR roe.callee_symbol_version_id = sv.symbol_version_id)
                  )
              )
        `, [snapshotId]);

        if (symbolsWithEvidence.rowCount === 0) {
            timer({ reduced: 0 });
            return 0;
        }

        let reduced = 0;
        const statements: { text: string; params: unknown[] }[] = [];

        // Flags that can be removed when runtime evidence exists
        const runtimeResolvableFlags = new Set([
            'dynamic_dispatch',
            'runtime_only_behavior',
            'type_inference_failure',
            'ambiguous_override',
        ]);

        for (const row of symbolsWithEvidence.rows as {
            symbol_version_id: string;
            uncertainty_flags: string[];
        }[]) {
            const currentFlags = row.uncertainty_flags;
            const flagsToRemove: string[] = [];

            for (const flag of currentFlags) {
                if (runtimeResolvableFlags.has(flag)) {
                    flagsToRemove.push(flag);
                }
            }

            if (flagsToRemove.length === 0) continue;

            const newFlags = currentFlags.filter(f => !flagsToRemove.includes(f));

            statements.push({
                text: `UPDATE symbol_versions
                       SET uncertainty_flags = $1
                       WHERE symbol_version_id = $2`,
                params: [newFlags, row.symbol_version_id],
            });
            reduced++;
        }

        // Step 2: Resolve 'unresolved' dispatch edges that now have runtime targets
        const unresolvedDispatch = await db.query(`
            SELECT de.dispatch_edge_id, de.caller_symbol_version_id, de.receiver_expression
            FROM dispatch_edges de
            WHERE de.snapshot_id = $1
              AND de.resolution_method = 'unresolved'
        `, [snapshotId]);

        for (const row of unresolvedDispatch.rows as {
            dispatch_edge_id: string;
            caller_symbol_version_id: string;
            receiver_expression: string;
        }[]) {
            // Check if runtime observed edges give us a callee for this caller
            const runtimeTarget = await db.query(`
                SELECT callee_symbol_version_id, receiver_type, SUM(call_count) as total_calls
                FROM runtime_observed_edges
                WHERE snapshot_id = $1
                  AND caller_symbol_version_id = $2
                  AND callee_symbol_version_id IS NOT NULL
                GROUP BY callee_symbol_version_id, receiver_type
                ORDER BY total_calls DESC
                LIMIT 5
            `, [snapshotId, row.caller_symbol_version_id]);

            if (runtimeTarget.rowCount && runtimeTarget.rowCount > 0) {
                const targets = runtimeTarget.rows as {
                    callee_symbol_version_id: string;
                    receiver_type: string | null;
                    total_calls: string;
                }[];

                const resolvedIds = targets.map(t => t.callee_symbol_version_id);
                const receiverTypes = targets
                    .map(t => t.receiver_type)
                    .filter((t): t is string => t !== null);
                const totalCalls = targets.reduce(
                    (sum, t) => sum + parseInt(t.total_calls, 10),
                    0,
                );
                const confidence = Math.min(
                    CONFIDENCE_CAP,
                    RUNTIME_EDGE_BASE_CONFIDENCE + Math.log10(Math.max(1, totalCalls)) * 0.05,
                );

                statements.push({
                    text: `UPDATE dispatch_edges
                           SET resolved_symbol_version_ids = $1,
                               receiver_types = $2,
                               resolution_method = 'runtime_observed',
                               confidence = $3,
                               is_polymorphic = $4
                           WHERE dispatch_edge_id = $5`,
                    params: [
                        resolvedIds,
                        receiverTypes,
                        confidence,
                        resolvedIds.length > 1,
                        row.dispatch_edge_id,
                    ],
                });
                reduced++;
            }
        }

        // Step 3: Boost confidence on dispatch_edges that have runtime confirmation
        statements.push({
            text: `UPDATE dispatch_edges de
                   SET confidence = LEAST(1.0, de.confidence + $1)
                   WHERE de.snapshot_id = $2
                     AND de.resolution_method != 'unresolved'
                     AND de.resolution_method != 'runtime_observed'
                     AND EXISTS (
                         SELECT 1 FROM runtime_observed_edges roe
                         WHERE roe.snapshot_id = $2
                           AND roe.caller_symbol_version_id = de.caller_symbol_version_id
                           AND roe.callee_symbol_version_id = ANY(de.resolved_symbol_version_ids)
                     )`,
            params: [RUNTIME_CONFIRMATION_BOOST, snapshotId],
        });

        // Persist all changes
        if (statements.length > 0) {
            for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
                const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
                await db.batchInsert(chunk);
            }
        }

        timer({ reduced, dispatch_checked: unresolvedDispatch.rowCount });
        return reduced;
    }

    // ──────────────────────────────────────────────────────────
    // 6. DYNAMIC ROUTE & FRAMEWORK EVENT PROCESSING
    // ──────────────────────────────────────────────────────────

    /**
     * Process dynamic route registrations from trace data.
     * Creates structural relations between route handlers and the framework
     * infrastructure, with 'framework_declared' provenance.
     */
    private async processDynamicRoutes(
        _snapshotId: string,
        routes: TraceDynamicRoute[],
        lookupIndex: SymbolLookupIndex,
    ): Promise<void> {
        if (!routes || routes.length === 0) return;

        const statements: { text: string; params: unknown[] }[] = [];

        for (const route of routes) {
            if (!route.handler_key || !route.route) continue;

            const handlerSvId = this.resolveKeyToSymbolVersion(route.handler_key, lookupIndex);
            if (!handlerSvId) {
                log.debug('Could not resolve dynamic route handler', {
                    handler_key: route.handler_key,
                    route: route.route,
                });
                continue;
            }

            // Persist route-to-handler binding as a framework_declared relation.
            // Store the route metadata in the contract_profiles api_contract_refs.
            const routeRef = `${route.method || 'ANY'} ${route.route}`;

            statements.push({
                text: `UPDATE contract_profiles
                       SET api_contract_refs = (
                           SELECT array_agg(DISTINCT elem)
                           FROM unnest(array_append(api_contract_refs, $1)) AS elem
                       )
                       WHERE symbol_version_id = $2`,
                params: [routeRef, handlerSvId],
            });
        }

        if (statements.length > 0) {
            await db.batchInsert(statements);
        }
    }

    /**
     * Process observed type information to refine dispatch edges.
     */
    private async processObservedTypes(
        snapshotId: string,
        observedTypes: TraceObservedType[],
    ): Promise<void> {
        if (!observedTypes || observedTypes.length === 0) return;

        const statements: { text: string; params: unknown[] }[] = [];

        for (const obs of observedTypes) {
            if (!obs.expression || !obs.observed_type) continue;

            // Find dispatch_edges that reference this receiver expression
            // and update their receiver_types with the observed type
            statements.push({
                text: `UPDATE dispatch_edges
                       SET receiver_types = (
                           SELECT array_agg(DISTINCT elem)
                           FROM unnest(array_append(receiver_types, $1)) AS elem
                       ),
                       confidence = GREATEST(confidence, $2)
                       WHERE snapshot_id = $3
                         AND receiver_expression = $4`,
                params: [
                    obs.observed_type,
                    FILE_LINE_MATCH_CONFIDENCE,
                    snapshotId,
                    obs.expression,
                ],
            });
        }

        if (statements.length > 0) {
            for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
                const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
                await db.batchInsert(chunk);
            }
        }
    }

    /**
     * Process framework events (decorator expansions, ORM registrations,
     * event handler bindings, etc.).
     *
     * Framework events carry a string `detail` field. We parse it as JSON
     * when possible, falling back to treating it as a plain descriptor string.
     */
    private async processFrameworkEvents(
        _snapshotId: string,
        events: TraceFrameworkEvent[],
        lookupIndex: SymbolLookupIndex,
    ): Promise<void> {
        if (!events || events.length === 0) return;

        const statements: { text: string; params: unknown[] }[] = [];

        for (const event of events) {
            if (!event.event_type || !event.detail) continue;

            // Parse detail: the canonical type defines it as `string`,
            // but it may carry structured JSON that we can extract fields from
            let detailObj: Record<string, unknown> = {};
            if (typeof event.detail === 'string') {
                try {
                    const parsed: unknown = JSON.parse(event.detail);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        detailObj = parsed as Record<string, unknown>;
                    }
                } catch {
                    // Plain string detail — use as-is below
                    detailObj = { raw: event.detail };
                }
            }

            switch (event.event_type) {
                case 'route_bind': {
                    const handlerKey = typeof detailObj['handler_key'] === 'string' ? detailObj['handler_key'] : undefined;
                    const route = typeof detailObj['route'] === 'string' ? detailObj['route'] : undefined;
                    const method = typeof detailObj['method'] === 'string' ? detailObj['method'] : undefined;
                    if (handlerKey && route) {
                        const svId = this.resolveKeyToSymbolVersion(handlerKey, lookupIndex);
                        if (svId) {
                            const routeRef = `${method || 'ANY'} ${route}`;
                            statements.push({
                                text: `UPDATE contract_profiles
                                       SET api_contract_refs = (
                                           SELECT array_agg(DISTINCT elem)
                                           FROM unnest(array_append(api_contract_refs, $1)) AS elem
                                       )
                                       WHERE symbol_version_id = $2`,
                                params: [routeRef, svId],
                            });
                        }
                    }
                    break;
                }

                case 'orm_register': {
                    const modelKey = typeof detailObj['model_key'] === 'string' ? detailObj['model_key'] : undefined;
                    const tableName = typeof detailObj['table_name'] === 'string' ? detailObj['table_name'] : undefined;
                    if (modelKey && tableName) {
                        const svId = this.resolveKeyToSymbolVersion(modelKey, lookupIndex);
                        if (svId) {
                            statements.push({
                                text: `UPDATE behavioral_profiles
                                       SET db_reads = (
                                           SELECT array_agg(DISTINCT elem)
                                           FROM unnest(array_append(db_reads, $1)) AS elem
                                       ),
                                       db_writes = (
                                           SELECT array_agg(DISTINCT elem)
                                           FROM unnest(array_append(db_writes, $1)) AS elem
                                       ),
                                       resource_touches = (
                                           SELECT array_agg(DISTINCT elem)
                                           FROM unnest(array_append(resource_touches, $2)) AS elem
                                       )
                                       WHERE symbol_version_id = $3`,
                                params: [tableName, `db:orm:${tableName}`, svId],
                            });
                        }
                    }
                    break;
                }

                case 'decorator_expand': {
                    const targetKey = typeof detailObj['target_key'] === 'string' ? detailObj['target_key'] : undefined;
                    const expandedKey = typeof detailObj['expanded_key'] === 'string' ? detailObj['expanded_key'] : undefined;
                    if (targetKey && expandedKey) {
                        const targetSvId = this.resolveKeyToSymbolVersion(targetKey, lookupIndex);
                        const expandedSvId = this.resolveKeyToSymbolVersion(expandedKey, lookupIndex);
                        if (targetSvId && expandedSvId) {
                            statements.push({
                                text: `INSERT INTO structural_relations
                                    (relation_id, src_symbol_version_id, dst_symbol_version_id,
                                     relation_type, strength, source, confidence, provenance)
                                VALUES ($1, $2, $3, 'calls', 1.0, 'runtime_trace', $4, 'framework_declared')
                                ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type)
                                DO UPDATE SET
                                    confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence),
                                    provenance = 'framework_declared'`,
                                params: [uuidv4(), targetSvId, expandedSvId, RUNTIME_EDGE_BASE_CONFIDENCE],
                            });
                        }
                    }
                    break;
                }

                case 'event_handler': {
                    const emitterKey = typeof detailObj['emitter_key'] === 'string' ? detailObj['emitter_key'] : undefined;
                    const handlerKey = typeof detailObj['handler_key'] === 'string' ? detailObj['handler_key'] : undefined;
                    if (emitterKey && handlerKey) {
                        const emitterSvId = this.resolveKeyToSymbolVersion(emitterKey, lookupIndex);
                        const handlerSvId = this.resolveKeyToSymbolVersion(handlerKey, lookupIndex);
                        if (emitterSvId && handlerSvId) {
                            statements.push({
                                text: `INSERT INTO structural_relations
                                    (relation_id, src_symbol_version_id, dst_symbol_version_id,
                                     relation_type, strength, source, confidence, provenance)
                                VALUES ($1, $2, $3, 'calls', 0.8, 'runtime_trace', $4, 'runtime_observed')
                                ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type)
                                DO UPDATE SET
                                    confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence)`,
                                params: [uuidv4(), emitterSvId, handlerSvId, RUNTIME_EDGE_BASE_CONFIDENCE],
                            });
                        }
                    }
                    break;
                }

                case 'middleware_mount': {
                    const appKey = typeof detailObj['app_key'] === 'string' ? detailObj['app_key'] : undefined;
                    const middlewareKey = typeof detailObj['middleware_key'] === 'string' ? detailObj['middleware_key'] : undefined;
                    if (appKey && middlewareKey) {
                        const appSvId = this.resolveKeyToSymbolVersion(appKey, lookupIndex);
                        const mwSvId = this.resolveKeyToSymbolVersion(middlewareKey, lookupIndex);
                        if (appSvId && mwSvId) {
                            statements.push({
                                text: `INSERT INTO structural_relations
                                    (relation_id, src_symbol_version_id, dst_symbol_version_id,
                                     relation_type, strength, source, confidence, provenance)
                                VALUES ($1, $2, $3, 'calls', 1.0, 'runtime_trace', $4, 'framework_declared')
                                ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type)
                                DO UPDATE SET
                                    confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence)`,
                                params: [uuidv4(), appSvId, mwSvId, RUNTIME_EDGE_BASE_CONFIDENCE],
                            });
                        }
                    }
                    break;
                }

                default:
                    log.debug('Unknown framework event type', {
                        event_type: event.event_type,
                    });
            }
        }

        if (statements.length > 0) {
            for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
                const chunk = statements.slice(i, i + BATCH_CHUNK_SIZE);
                await db.batchInsert(chunk);
            }
        }
    }

    // ──────────────────────────────────────────────────────────
    // 7. EVIDENCE QUERY
    // ──────────────────────────────────────────────────────────

    /**
     * Get all runtime evidence for a symbol:
     *   - observed as caller (outgoing edges)
     *   - observed as callee (incoming edges)
     *   - observed types
     *   - dynamic route bindings
     *   - total observation count
     *   - temporal range (first/last observed)
     *   - computed confidence boost
     */
    async getEvidenceForSymbol(symbolVersionId: string): Promise<RuntimeEvidenceExtended> {
        // Parallel queries for all evidence dimensions
        const [callerEdges, calleeEdges, tracesWithTypes, routeData] = await Promise.all([
            // Observed as caller
            db.query(`
                SELECT roe.callee_symbol_version_id, roe.receiver_type,
                       roe.call_count, roe.confidence,
                       rt.trace_source
                FROM runtime_observed_edges roe
                JOIN runtime_traces rt ON rt.trace_id = roe.trace_id
                WHERE roe.caller_symbol_version_id = $1
                ORDER BY roe.call_count DESC
            `, [symbolVersionId]),

            // Observed as callee
            db.query(`
                SELECT roe.caller_symbol_version_id, roe.receiver_type,
                       roe.call_count, roe.confidence,
                       rt.trace_source
                FROM runtime_observed_edges roe
                JOIN runtime_traces rt ON rt.trace_id = roe.trace_id
                WHERE roe.callee_symbol_version_id = $1
                ORDER BY roe.call_count DESC
            `, [symbolVersionId]),

            // Traces that contain observed types relevant to this symbol
            db.query(`
                SELECT rt.observed_types, rt.trace_source
                FROM runtime_traces rt
                JOIN runtime_observed_edges roe ON roe.trace_id = rt.trace_id
                WHERE (roe.caller_symbol_version_id = $1 OR roe.callee_symbol_version_id = $1)
                  AND rt.observed_types != '[]'::jsonb
                LIMIT 50
            `, [symbolVersionId]),

            // Dynamic routes for this symbol
            db.query(`
                SELECT rt.dynamic_routes
                FROM runtime_traces rt
                JOIN runtime_observed_edges roe ON roe.trace_id = rt.trace_id
                WHERE (roe.caller_symbol_version_id = $1 OR roe.callee_symbol_version_id = $1)
                  AND rt.dynamic_routes != '[]'::jsonb
                LIMIT 20
            `, [symbolVersionId]),
        ]);

        // Build caller summaries
        const observedAsCaller: ObservedEdgeSummary[] = (callerEdges.rows as {
            callee_symbol_version_id: string | null;
            receiver_type: string | null;
            call_count: number;
            confidence: number;
            trace_source: string;
        }[]).map(row => ({
            counterpart_symbol_version_id: row.callee_symbol_version_id,
            receiver_type: row.receiver_type,
            call_count: row.call_count,
            confidence: row.confidence,
            trace_source: row.trace_source,
        }));

        // Build callee summaries
        const observedAsCallee: ObservedEdgeSummary[] = (calleeEdges.rows as {
            caller_symbol_version_id: string | null;
            receiver_type: string | null;
            call_count: number;
            confidence: number;
            trace_source: string;
        }[]).map(row => ({
            counterpart_symbol_version_id: row.caller_symbol_version_id,
            receiver_type: row.receiver_type,
            call_count: row.call_count,
            confidence: row.confidence,
            trace_source: row.trace_source,
        }));

        // Aggregate observed types across traces
        const allObservedTypes: TraceObservedType[] = [];
        const seenTypes = new Set<string>();
        for (const row of tracesWithTypes.rows as { observed_types: TraceObservedType[] }[]) {
            if (Array.isArray(row.observed_types)) {
                for (const obs of row.observed_types) {
                    const key = `${obs.expression}:${obs.observed_type}`;
                    if (!seenTypes.has(key)) {
                        seenTypes.add(key);
                        allObservedTypes.push(obs);
                    }
                }
            }
        }

        // Aggregate dynamic routes
        const allRoutes: TraceDynamicRoute[] = [];
        const seenRoutes = new Set<string>();
        for (const row of routeData.rows as { dynamic_routes: TraceDynamicRoute[] }[]) {
            if (Array.isArray(row.dynamic_routes)) {
                for (const route of row.dynamic_routes) {
                    const key = `${route.method}:${route.route}:${route.handler_key}`;
                    if (!seenRoutes.has(key)) {
                        seenRoutes.add(key);
                        allRoutes.push(route);
                    }
                }
            }
        }

        // Compute temporal range
        const temporalResult = await db.query(`
            SELECT MIN(first_observed) as first_obs, MAX(last_observed) as last_obs
            FROM runtime_observed_edges
            WHERE caller_symbol_version_id = $1 OR callee_symbol_version_id = $1
        `, [symbolVersionId]);

        const temporal = temporalResult.rows[0] as {
            first_obs: Date | null;
            last_obs: Date | null;
        } | undefined;

        const totalObservations = observedAsCaller.length + observedAsCallee.length;

        // Confidence boost: more evidence sources = higher boost
        const sourceSet = new Set<string>();
        for (const e of observedAsCaller) { sourceSet.add(e.trace_source); }
        for (const e of observedAsCallee) { sourceSet.add(e.trace_source); }
        const sourceDiversity = sourceSet.size;

        const confidenceBoost = Math.min(
            0.30,
            totalObservations > 0
                ? RUNTIME_CONFIRMATION_BOOST * Math.min(sourceDiversity, 3)
                : 0,
        );

        return {
            symbol_version_id: symbolVersionId,
            observed_as_caller: observedAsCaller,
            observed_as_callee: observedAsCallee,
            observed_types: allObservedTypes,
            dynamic_routes: allRoutes,
            total_observations: totalObservations,
            first_observed: temporal?.first_obs ?? null,
            last_observed: temporal?.last_obs ?? null,
            confidence_boost: confidenceBoost,
        };
    }

    // ──────────────────────────────────────────────────────────
    // HELPERS
    // ──────────────────────────────────────────────────────────

    /**
     * Normalize a file path for consistent matching.
     * Strips leading './', collapses '//', converts backslashes.
     */
    private normalizePath(filePath: string): string {
        let normalized = filePath
            .replace(/\\/g, '/')        // Windows backslashes
            .replace(/^\.\//, '')       // leading ./
            .replace(/\/\//g, '/');     // double slashes

        // Strip common prefixes that may differ between runtime and index
        const prefixPatterns = [
            /^.*?\/node_modules\//,    // node_modules prefix
            /^.*?\/dist\//,            // compiled output
            /^.*?\/build\//,           // build output
            /^.*?\/src\//,             // may or may not have src/
        ];

        // Only strip if the result still has content
        for (const pattern of prefixPatterns) {
            const stripped = normalized.replace(pattern, '');
            if (stripped.length > 0 && stripped !== normalized) {
                normalized = stripped;
                break;  // Only strip the first matching prefix
            }
        }

        return normalized;
    }

    /**
     * Extract the simple (unqualified) function name from a potentially
     * qualified name like "Module.Class.method" or "namespace::func".
     */
    private extractSimpleName(qualifiedName: string): string {
        // Handle common separators: '.', '::', '/', '#'
        const parts = qualifiedName.split(/[.:#/]/);
        const last = parts[parts.length - 1];
        return last || qualifiedName;
    }

    /**
     * Attempt to demangle a mangled/minified/generated function name.
     * Handles common patterns from bundlers, transpilers, and runtimes.
     */
    private demangleName(name: string): string {
        let demangled = name;

        // Strip common mangling suffixes
        // Webpack: __WEBPACK_IMPORTED_MODULE_0__
        demangled = demangled.replace(/__WEBPACK_IMPORTED_MODULE_\d+__/g, '');

        // Babel: _classCallCheck, _createClass wrappers
        demangled = demangled.replace(/^_(?:classCallCheck|createClass|possibleConstructorReturn|inherits)$/, '');

        // TypeScript: __awaiter, __generator, __decorate
        demangled = demangled.replace(/^__(?:awaiter|generator|decorate|param|metadata|asyncGenerator|asyncDelegator|asyncValues|rest|spread|spreadArrays)$/, '');

        // Minifier: single-letter names are not resolvable
        if (demangled.length <= 1) return name;

        // Strip numeric suffixes added by bundlers: funcName$1, funcName_2
        demangled = demangled.replace(/[$_]\d+$/, '');

        // Strip 'bound ' prefix from .bind() calls
        demangled = demangled.replace(/^bound\s+/, '');

        // Strip 'async ' prefix
        demangled = demangled.replace(/^async\s+/, '');

        // Strip anonymous wrapper patterns: '<anonymous>', '(anonymous)'
        if (/^[<(]anonymous[>)]$/.test(demangled)) return name;

        return demangled;
    }

    /**
     * Compute confidence for an observed edge based on how well both
     * sides were resolved and the observation count.
     */
    private computeEdgeConfidence(
        callerSvId: string | null,
        calleeSvId: string | null,
        callCount: number,
    ): number {
        let base: number;

        if (callerSvId && calleeSvId) {
            // Both sides resolved — high base confidence
            base = 0.90;
        } else {
            // Only one side resolved — useful but less certain
            base = PARTIAL_MATCH_CONFIDENCE;
        }

        // Observation-count scaling: log10(calls) bonus, capped
        const countBonus = Math.min(0.10, Math.log10(Math.max(1, callCount)) * 0.03);

        return Math.min(CONFIDENCE_CAP, base + countBonus);
    }
}

export const runtimeEvidenceEngine = new RuntimeEvidenceEngine();
