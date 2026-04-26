/**
 * ContextZero -- Whole-Program Dispatch Resolver
 *
 * Solves the V1 limitation: inability to follow `self.field.method()` chains
 * or understand object-oriented dispatch. This engine provides:
 *
 *   1. Class Hierarchy Analysis  -- inheritance graph + C3 linearization MRO
 *   2. Receiver Type Inference   -- constructor, annotation, DI, factory patterns
 *   3. Field-Sensitive Points-To -- allocation sites, field assignments, alias sets
 *   4. Chained Member Access     -- walk `self.service.repository.find()` step-by-step
 *   5. Dispatch Edge Creation    -- create dispatch_edges with confidence + provenance
 *
 * All results are persisted to the dispatch_edges and class_hierarchy tables
 * defined in migration 007_v2_upgrade.sql.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { coreDataService, type SymbolVersionRow } from '../db-driver/core_data';
import { Logger } from '../logger';
import type { StructuralRelationType } from '../types';

const log = new Logger('dispatch-resolver');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single resolved dispatch edge. */
export interface DispatchEdge {
    dispatch_edge_id: string;
    snapshot_id: string;
    caller_symbol_version_id: string;
    receiver_expression: string;
    receiver_types: string[];
    resolved_symbol_version_ids: string[];
    resolution_method: string;
    confidence: number;
    is_polymorphic: boolean;
    class_hierarchy_depth: number | null;
    override_chain: string[] | null;
    created_at: Date;
}

/** Result of resolving a single member-access chain. */
export interface DispatchResolution {
    chain: string;
    segments: ChainSegment[];
    final_receiver_types: string[];
    resolved_symbol_version_ids: string[];
    resolution_method: string;
    confidence: number;
    is_polymorphic: boolean;
    unresolved_reason: string | null;
}

/** One segment of a chained member access resolution. */
interface ChainSegment {
    segment: string;
    inferred_types: string[];
    resolution_method: string;
    confidence: number;
}

/** Internal representation of a class in the hierarchy graph. */
interface ClassNode {
    symbolVersionId: string;
    symbolId: string;
    canonicalName: string;
    kind: string;
    parents: { svId: string; relationKind: string }[];
    children: string[];
    methods: Map<string, string>; // method canonical_name -> method svId
}

/** A field-level points-to fact. */
interface PointsToFact {
    ownerSvId: string;
    fieldName: string;
    possibleTypes: string[];
    allocationSvIds: string[];
    source: 'constructor_assignment' | 'field_annotation' | 'factory_return'
          | 'dependency_injection' | 'dataclass_attr' | 'local_flow';
    confidence: number;
}

/** Extracted member-access callsite from source. */
interface MemberCallsite {
    callerSvId: string;
    receiverExpression: string;
    methodName: string;
    line: number;
}

// ---------------------------------------------------------------------------
// Resolution method constants
// ---------------------------------------------------------------------------

const RESOLUTION = {
    TYPE_ANNOTATION: 'type_annotation',
    CONSTRUCTOR_ASSIGNMENT: 'constructor_assignment',
    FIELD_INFERENCE: 'field_inference',
    INHERITANCE_MRO: 'inheritance_mro',
    FACTORY_RETURN: 'factory_return',
    DEPENDENCY_INJECTION: 'dependency_injection',
    DATACLASS_ATTR: 'dataclass_attr',
    RUNTIME_OBSERVED: 'runtime_observed',
    LOCAL_FLOW: 'local_flow',
    UNRESOLVED: 'unresolved',
} as const;

// ---------------------------------------------------------------------------
// Patterns for source-level inference
// ---------------------------------------------------------------------------

/**
 * Regex patterns for extracting type information from source code.
 *
 * Each pattern is designed to be applied per-line against body_source.
 * Capture groups: (field_name) and (type_name) where applicable.
 */

// this.foo = new Bar(...)  or  self.foo = Bar(...)
const CONSTRUCTOR_ASSIGN_RE = /(?:this|self)\s*\.\s*(\w+)\s*=\s*new\s+(\w[\w.]*)\s*\(/;

// TypeScript field annotation:  private foo: Bar  or  foo: Bar
const TS_FIELD_ANNOTATION_RE = /(?:private|protected|public|readonly)?\s*(\w+)\s*:\s*(\w[\w.<>,\s|]*)\s*[;=]/;

// Python type annotation:  self.foo: Bar  or  foo: Bar = ...
const PY_FIELD_ANNOTATION_RE = /(?:self\.\s*)?(\w+)\s*:\s*(\w[\w.,\s|]*)\s*(?:=|$)/;

// Dependency injection: @Inject(Bar) foo  or  constructor(private foo: Bar)
const DI_CONSTRUCTOR_PARAM_RE = /(?:private|protected|public|readonly)\s+(\w+)\s*:\s*(\w[\w.<>,\s|]*)/;

// Factory / return type:  foo = SomeFactory.create(...)  or  foo = create_bar(...)
const FACTORY_ASSIGN_RE = /(?:this|self)\s*\.\s*(\w+)\s*=\s*(?:(\w[\w.]*)\s*\.\s*)?(\w+)\s*\(/;

// Python dataclass/Pydantic field:  foo: Bar = Field(...)  or  foo: Bar = field(...)
const DATACLASS_FIELD_RE = /(\w+)\s*:\s*(\w[\w.,\s|]*)\s*=\s*(?:Field|field|Column|Depends)\s*\(/;

// Member access chain in source: self.a.b.c(...)  or  this.a.b.c(...)
const MEMBER_CHAIN_CALL_RE = /(?:this|self)\s*(\.\s*\w+(?:\s*\.\s*\w+)*)\s*\(/g;

// ---------------------------------------------------------------------------
// DispatchResolver
// ---------------------------------------------------------------------------

export class DispatchResolver {

    // -----------------------------------------------------------------------
    // CANONICAL NAME LOOKUP HELPERS
    // -----------------------------------------------------------------------

    /**
     * Look up the first SymbolVersionRow matching a canonical name.
     * When multiple symbols share the same canonical name (e.g., two
     * `validate` methods in different files), returns the first entry.
     */
    private static svByCanonicalFirst(
        map: Map<string, SymbolVersionRow[]>,
        name: string,
    ): SymbolVersionRow | undefined {
        const arr = map.get(name);
        return arr ? arr[0] : undefined;
    }

    /**
     * Look up a SymbolVersionRow by canonical name, preferring one whose
     * file_id matches `contextFileId` (the caller's file). Falls back to
     * the first entry when no file-context match is found.
     */
    private static svByCanonicalInFile(
        map: Map<string, SymbolVersionRow[]>,
        name: string,
        contextFileId: string | undefined,
    ): SymbolVersionRow | undefined {
        const arr = map.get(name);
        if (!arr || arr.length === 0) return undefined;
        if (arr.length === 1 || !contextFileId) return arr[0];
        return arr.find(sv => sv.file_id === contextFileId) ?? arr[0];
    }

    /**
     * Populate the canonical-name multi-map from an array of rows.
     */
    private static buildCanonicalMap(
        svRows: SymbolVersionRow[],
    ): Map<string, SymbolVersionRow[]> {
        const map = new Map<string, SymbolVersionRow[]>();
        for (const sv of svRows) {
            const existing = map.get(sv.canonical_name);
            if (existing) {
                existing.push(sv);
            } else {
                map.set(sv.canonical_name, [sv]);
            }
        }
        return map;
    }

    // -----------------------------------------------------------------------
    // 1. CLASS HIERARCHY ANALYSIS
    // -----------------------------------------------------------------------

    /**
     * Build the class_hierarchy table for a snapshot from structural_relations.
     *
     * Reads `inherits`, `implements`, and `overrides` relations, then:
     *   - inserts self-entry (mro_position=0) for every class/interface
     *   - inserts parent entries
     *   - computes C3 linearization MRO for each class
     *
     * Returns the number of hierarchy records inserted.
     */
    async buildClassHierarchy(snapshotId: string): Promise<number> {
        const timer = log.startTimer('buildClassHierarchy', { snapshotId });

        // Load all symbol versions for the snapshot
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);

        // Index by symbol_version_id and canonical_name (multi-map to avoid collision)
        const svById = new Map<string, SymbolVersionRow>();
        const svByCanonical = DispatchResolver.buildCanonicalMap(svRows);
        for (const sv of svRows) {
            svById.set(sv.symbol_version_id, sv);
        }

        // Load inheritance/implementation/override relations
        const relResult = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id, sr.relation_type, sr.confidence
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
            AND sr.relation_type IN ('inherits', 'implements', 'overrides')
        `, [snapshotId]);

        type RelRow = {
            src_symbol_version_id: string;
            dst_symbol_version_id: string;
            relation_type: StructuralRelationType;
            confidence: number;
        };

        const relRows = relResult.rows as RelRow[];

        // Build class graph
        const classGraph = new Map<string, ClassNode>();

        // Ensure all class/interface symbol versions have a node
        for (const sv of svRows) {
            if (sv.kind === 'class' || sv.kind === 'interface') {
                classGraph.set(sv.symbol_version_id, {
                    symbolVersionId: sv.symbol_version_id,
                    symbolId: sv.symbol_id,
                    canonicalName: sv.canonical_name,
                    kind: sv.kind,
                    parents: [],
                    children: [],
                    methods: new Map(),
                });
            }
        }

        // Populate parent/child links
        for (const rel of relRows) {
            if (rel.relation_type === 'inherits' || rel.relation_type === 'implements') {
                const childNode = classGraph.get(rel.src_symbol_version_id);
                if (childNode) {
                    const relationKind = rel.relation_type === 'inherits' ? 'extends' : 'implements';
                    childNode.parents.push({ svId: rel.dst_symbol_version_id, relationKind });
                }
                const parentNode = classGraph.get(rel.dst_symbol_version_id);
                if (parentNode) {
                    parentNode.children.push(rel.src_symbol_version_id);
                }
            }
        }

        // Collect methods belonging to each class
        // A method belongs to a class if a structural relation of type 'defines' exists,
        // or if the method's stable_key prefix matches the class canonical name.
        const methodRelResult = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
            AND sr.relation_type = 'defines'
        `, [snapshotId]);

        for (const row of methodRelResult.rows as { src_symbol_version_id: string; dst_symbol_version_id: string }[]) {
            const classNode = classGraph.get(row.src_symbol_version_id);
            const methodSv = svById.get(row.dst_symbol_version_id);
            if (classNode && methodSv && (methodSv.kind === 'method' || methodSv.kind === 'function')) {
                classNode.methods.set(methodSv.canonical_name, methodSv.symbol_version_id);
            }
        }

        // Also infer class membership from canonical_name nesting (e.g., "Foo.bar" belongs to "Foo")
        for (const sv of svRows) {
            if (sv.kind !== 'method') continue;
            const dotIdx = sv.canonical_name.lastIndexOf('.');
            if (dotIdx === -1) continue;
            const parentName = sv.canonical_name.substring(0, dotIdx);
            const parentSv = DispatchResolver.svByCanonicalInFile(svByCanonical, parentName, sv.file_id);
            if (parentSv) {
                const classNode = classGraph.get(parentSv.symbol_version_id);
                if (classNode && !classNode.methods.has(sv.canonical_name)) {
                    classNode.methods.set(sv.canonical_name, sv.symbol_version_id);
                }
            }
        }

        // Compute C3 linearization for each class and insert hierarchy records
        const statements: { text: string; params: unknown[] }[] = [];
        let insertedCount = 0;

        // Prepend the delete as the first statement so the entire
        // DELETE + INSERT sequence is atomic within a single transaction.
        statements.push({
            text: `DELETE FROM class_hierarchy WHERE snapshot_id = $1`,
            params: [snapshotId],
        });

        for (const [svId, node] of classGraph) {
            const mro = this.computeC3Linearization(svId, classGraph);

            for (let position = 0; position < mro.length; position++) {
                const ancestorSvId = mro[position];
                const relationKind = position === 0
                    ? 'self'
                    : (node.parents.find(p => p.svId === ancestorSvId)?.relationKind ?? 'extends');

                statements.push({
                    text: `INSERT INTO class_hierarchy (hierarchy_id, snapshot_id, class_symbol_version_id, parent_symbol_version_id, mro_position, relation_kind)
                           VALUES ($1, $2, $3, $4, $5, $6)
                           ON CONFLICT (snapshot_id, class_symbol_version_id, parent_symbol_version_id)
                           DO UPDATE SET mro_position = EXCLUDED.mro_position, relation_kind = EXCLUDED.relation_kind`,
                    params: [
                        uuidv4(),
                        snapshotId,
                        svId,
                        position === 0 ? null : ancestorSvId,
                        position,
                        relationKind,
                    ],
                });
                insertedCount++;
            }
        }

        if (statements.length > 0) {
            // Wrap DELETE + all INSERTs in a single transaction for atomicity
            await db.transaction(async (client) => {
                for (const stmt of statements) {
                    await client.query(stmt.text, stmt.params);
                }
            });
        }

        timer({ classes: classGraph.size, hierarchy_records: insertedCount });
        return insertedCount;
    }

    /**
     * C3 Linearization (Method Resolution Order).
     *
     * Given a class node and the full class graph, compute the MRO as an ordered
     * list of symbol_version_ids. The algorithm follows the standard C3 merge:
     *
     *   L[C] = C + merge(L[B1], ..., L[Bn], [B1, ..., Bn])
     *
     * where B1..Bn are the direct parents of C in declaration order.
     *
     * Falls back to a simple DFS order if C3 fails (e.g., inconsistent hierarchy).
     */
    private computeC3Linearization(
        classSvId: string,
        graph: Map<string, ClassNode>,
    ): string[] {
        const cache = new Map<string, string[]>();
        return this.c3Linearize(classSvId, graph, cache, new Set());
    }

    private c3Linearize(
        svId: string,
        graph: Map<string, ClassNode>,
        cache: Map<string, string[]>,
        visiting: Set<string>,
    ): string[] {
        // Return cached result if available
        const cached = cache.get(svId);
        if (cached) return cached;

        // Cycle detection
        if (visiting.has(svId)) {
            log.warn('Circular inheritance detected during C3 linearization', { svId });
            return [svId];
        }

        const node = graph.get(svId);
        if (!node) {
            return [svId];
        }

        const parentSvIds = node.parents.map(p => p.svId);

        // Base case: no parents
        if (parentSvIds.length === 0) {
            const result = [svId];
            cache.set(svId, result);
            return result;
        }

        visiting.add(svId);

        // Recursively compute parent linearizations
        const parentLinearizations: string[][] = [];
        for (const parentId of parentSvIds) {
            parentLinearizations.push(this.c3Linearize(parentId, graph, cache, visiting));
        }

        visiting.delete(svId);

        // Merge: C + merge(L(B1), ..., L(Bn), [B1,...,Bn])
        const mergeInputs = [
            ...parentLinearizations.map(l => [...l]),
            [...parentSvIds],
        ];

        const result = [svId];
        const merged = this.c3Merge(mergeInputs);

        if (merged === null) {
            // C3 failed -- fall back to DFS
            log.warn('C3 linearization failed, falling back to DFS', { svId });
            const dfs = this.dfsMRO(svId, graph, new Set());
            cache.set(svId, dfs);
            return dfs;
        }

        result.push(...merged);
        cache.set(svId, result);
        return result;
    }

    /**
     * C3 merge of multiple linearization lists.
     * Returns null if linearization is inconsistent.
     */
    private c3Merge(lists: string[][]): string[] | null {
        const result: string[] = [];
        const MAX_ITERATIONS = 500;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            // Remove empty lists
            const nonEmpty = lists.filter(l => l.length > 0);
            if (nonEmpty.length === 0) return result;

            // Find a good head: one that does not appear in the tail of any list
            let goodHead: string | null = null;

            for (const list of nonEmpty) {
                const candidate = list[0] as string | undefined;
                if (candidate === undefined) continue;
                const inTail = nonEmpty.some(other => other.indexOf(candidate, 1) !== -1);
                if (!inTail) {
                    goodHead = candidate;
                    break;
                }
            }

            if (goodHead === null) {
                // No valid linearization
                return null;
            }

            result.push(goodHead);

            // Remove goodHead from the front of all lists
            for (const list of lists) {
                if (list.length > 0 && list[0] === goodHead) {
                    list.shift();
                }
            }
        }

        log.warn('C3 merge exceeded max iterations');
        return null;
    }

    /**
     * Fallback DFS-based MRO when C3 fails.
     */
    private dfsMRO(
        svId: string,
        graph: Map<string, ClassNode>,
        visited: Set<string>,
    ): string[] {
        if (visited.has(svId)) return [];
        visited.add(svId);

        const result = [svId];
        const node = graph.get(svId);
        if (!node) return result;

        for (const parent of node.parents) {
            result.push(...this.dfsMRO(parent.svId, graph, visited));
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // 2. RECEIVER TYPE INFERENCE
    // -----------------------------------------------------------------------

    /**
     * Infer points-to facts for all symbols in a snapshot.
     *
     * Scans each method/function body_source for:
     *   - Constructor assignments (this.foo = new Bar())
     *   - Field type annotations (foo: Bar)
     *   - DI constructor parameters (constructor(private foo: Bar))
     *   - Dataclass/Pydantic fields (foo: Bar = Field(...))
     *   - Factory assignments (this.foo = Factory.create())
     *   - Local flow assignments
     *
     * Returns a map: owner_svId -> field_name -> PointsToFact[]
     */
    private inferPointsToFacts(
        svRows: SymbolVersionRow[],
        svByCanonical: Map<string, SymbolVersionRow[]>,
    ): Map<string, Map<string, PointsToFact>> {
        const facts = new Map<string, Map<string, PointsToFact>>();

        for (const sv of svRows) {
            const source = sv.body_source;
            if (!source) continue;

            // Determine the owning class for methods
            let ownerSvId: string | null = null;
            let ownerCanonical: string | null = null;

            if (sv.kind === 'method') {
                const dotIdx = sv.canonical_name.lastIndexOf('.');
                if (dotIdx !== -1) {
                    ownerCanonical = sv.canonical_name.substring(0, dotIdx);
                    const ownerSv = DispatchResolver.svByCanonicalInFile(svByCanonical, ownerCanonical, sv.file_id);
                    if (ownerSv) {
                        ownerSvId = ownerSv.symbol_version_id;
                    }
                }
            } else if (sv.kind === 'class') {
                ownerSvId = sv.symbol_version_id;
                ownerCanonical = sv.canonical_name;
            }

            if (!ownerSvId) continue;

            if (!facts.has(ownerSvId)) {
                facts.set(ownerSvId, new Map());
            }
            const ownerFacts = facts.get(ownerSvId)!;

            const lines = source.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();

                // 1. Constructor assignment: this.foo = new Bar(...)
                const ctorMatch = trimmed.match(CONSTRUCTOR_ASSIGN_RE);
                if (ctorMatch && ctorMatch[1] && ctorMatch[2]) {
                    const fieldName = ctorMatch[1];
                    const typeName = ctorMatch[2];
                    this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, typeName,
                        'constructor_assignment', 0.95, svByCanonical);
                    continue;
                }

                // 2. TypeScript field annotation: private foo: Bar
                const tsFieldMatch = trimmed.match(TS_FIELD_ANNOTATION_RE);
                if (tsFieldMatch && tsFieldMatch[1] && tsFieldMatch[2]) {
                    const fieldName = tsFieldMatch[1];
                    const rawType = tsFieldMatch[2].trim();
                    const types = this.parseUnionType(rawType);
                    for (const t of types) {
                        this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, t,
                            'field_annotation', 0.90, svByCanonical);
                    }
                    continue;
                }

                // 3. DI constructor parameter: constructor(private foo: Bar)
                const diMatch = trimmed.match(DI_CONSTRUCTOR_PARAM_RE);
                if (diMatch && diMatch[1] && diMatch[2] && (trimmed.includes('constructor') || sv.canonical_name.endsWith('.constructor') || sv.canonical_name.endsWith('.__init__'))) {
                    const fieldName = diMatch[1];
                    const rawType = diMatch[2].trim();
                    const types = this.parseUnionType(rawType);
                    for (const t of types) {
                        this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, t,
                            'dependency_injection', 0.92, svByCanonical);
                    }
                    continue;
                }

                // 4. Dataclass/Pydantic field: foo: Bar = Field(...)
                const dataclassMatch = trimmed.match(DATACLASS_FIELD_RE);
                if (dataclassMatch && dataclassMatch[1] && dataclassMatch[2]) {
                    const fieldName = dataclassMatch[1];
                    const rawType = dataclassMatch[2].trim();
                    const types = this.parseUnionType(rawType);
                    for (const t of types) {
                        this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, t,
                            'dataclass_attr', 0.93, svByCanonical);
                    }
                    continue;
                }

                // 5. Python field annotation: self.foo: Bar = ...
                const pyFieldMatch = trimmed.match(PY_FIELD_ANNOTATION_RE);
                if (pyFieldMatch && pyFieldMatch[1] && pyFieldMatch[2] && trimmed.includes('self.')) {
                    const fieldName = pyFieldMatch[1];
                    const rawType = pyFieldMatch[2].trim();
                    const types = this.parseUnionType(rawType);
                    for (const t of types) {
                        this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, t,
                            'field_annotation', 0.88, svByCanonical);
                    }
                    continue;
                }

                // 6. Rust struct field: field_name: TypeName
                const rustFieldMatch = trimmed.match(/^(\w+)\s*:\s*(\w[\w<>,\s]*)\s*[,}]/);
                if (rustFieldMatch && rustFieldMatch[1] && rustFieldMatch[2] && sv.language === 'rust') {
                    const fieldName = rustFieldMatch[1];
                    const rawType = rustFieldMatch[2].trim();
                    // Strip Rust generics: Box<Foo> → Foo, Arc<Foo> → Foo, Option<Foo> → Foo
                    const innerType = rawType.replace(/^(?:Box|Arc|Rc|Mutex|RwLock|Option|Vec|HashMap|BTreeMap|Result)\s*<\s*/, '').replace(/\s*>$/, '').split(',')[0]?.trim();
                    if (innerType) {
                        this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, innerType,
                            'field_annotation', 0.90, svByCanonical);
                    }
                    continue;
                }

                // 7. Java/C# field: private TypeName fieldName;
                const javaFieldMatch = trimmed.match(/^(?:private|protected|public|internal|readonly|final|static)?\s*(?:private|protected|public|internal|readonly|final|static)?\s*(\w[\w<>,.\s]*?)\s+(\w+)\s*[;=]/);
                if (javaFieldMatch && javaFieldMatch[1] && javaFieldMatch[2] && (sv.language === 'java' || sv.language === 'csharp')) {
                    const rawType = javaFieldMatch[1].trim();
                    const fieldName = javaFieldMatch[2];
                    // Skip primitives and common non-type keywords
                    if (!['int', 'long', 'float', 'double', 'boolean', 'byte', 'char', 'short', 'void', 'var', 'string', 'String'].includes(rawType)) {
                        this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, rawType,
                            'field_annotation', 0.90, svByCanonical);
                    }
                    continue;
                }

                // 8. Go struct field: FieldName TypeName
                const goFieldMatch = trimmed.match(/^(\w+)\s+(\*?\w[\w.]*)\s*(?:`|$|\/\/)/);
                if (goFieldMatch && goFieldMatch[1] && goFieldMatch[2] && sv.language === 'go') {
                    const fieldName = goFieldMatch[1];
                    const rawType = goFieldMatch[2].replace(/^\*/, ''); // strip pointer
                    this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, rawType,
                        'field_annotation', 0.88, svByCanonical);
                    continue;
                }

                // 9. Factory assignment: this.foo = SomeFactory.create(...)
                const factoryMatch = trimmed.match(FACTORY_ASSIGN_RE);
                if (factoryMatch && factoryMatch[1]) {
                    const fieldName = factoryMatch[1];
                    const factoryClass = factoryMatch[2];
                    const factoryMethod = factoryMatch[3];
                    if (factoryClass && factoryMethod) {
                        // Try to resolve the return type of the factory method
                        const factoryMethodName = `${factoryClass}.${factoryMethod}`;
                        const factorySv = DispatchResolver.svByCanonicalFirst(svByCanonical, factoryMethodName);
                        if (factorySv) {
                            const returnType = this.extractReturnType(factorySv.signature);
                            if (returnType) {
                                this.mergePointsToFact(ownerFacts, ownerSvId, fieldName, returnType,
                                    'factory_return', 0.80, svByCanonical);
                            }
                        }
                    }
                }
            }
        }

        return facts;
    }

    /**
     * Merge a single points-to fact into the fact map.
     * Higher-confidence facts take precedence.
     */
    private mergePointsToFact(
        ownerFacts: Map<string, PointsToFact>,
        ownerSvId: string,
        fieldName: string,
        typeName: string,
        source: PointsToFact['source'],
        confidence: number,
        svByCanonical: Map<string, SymbolVersionRow[]>,
    ): void {
        const existing = ownerFacts.get(fieldName);
        const allocationSvId = DispatchResolver.svByCanonicalFirst(svByCanonical, typeName)?.symbol_version_id;

        if (existing) {
            if (!existing.possibleTypes.includes(typeName)) {
                existing.possibleTypes.push(typeName);
            }
            if (allocationSvId && !existing.allocationSvIds.includes(allocationSvId)) {
                existing.allocationSvIds.push(allocationSvId);
            }
            // Keep the highest confidence
            if (confidence > existing.confidence) {
                existing.source = source;
                existing.confidence = confidence;
            }
        } else {
            ownerFacts.set(fieldName, {
                ownerSvId,
                fieldName,
                possibleTypes: [typeName],
                allocationSvIds: allocationSvId ? [allocationSvId] : [],
                source,
                confidence,
            });
        }
    }

    /**
     * Parse a union type string (e.g., "Foo | Bar | null") into individual type names.
     * Strips generics and nullable wrappers.
     */
    private parseUnionType(rawType: string): string[] {
        const types: string[] = [];

        // Split on | for union types
        const parts = rawType.split('|').map(s => s.trim());
        for (const part of parts) {
            // Strip generic parameters: Optional[Foo] -> Foo, Promise<Bar> -> Bar
            const cleaned = part
                .replace(/^Optional\[(.+)\]$/i, '$1')
                .replace(/^Promise<(.+)>$/i, '$1')
                .replace(/^Awaitable\[(.+)\]$/i, '$1')
                .replace(/<[^>]*>/g, '')   // strip remaining generics
                .replace(/\[.*\]/g, '')     // strip Python subscripts
                .trim();

            // Skip primitives and null
            if (['null', 'undefined', 'void', 'never', 'None', 'string', 'number',
                 'boolean', 'any', 'unknown', 'int', 'float', 'str', 'bool',
                 'bytes', 'object', 'Object'].includes(cleaned)) {
                continue;
            }

            if (cleaned.length > 0) {
                types.push(cleaned);
            }
        }

        return types;
    }

    /**
     * Extract return type from a function/method signature string.
     *
     * Examples:
     *   "createFoo(): Foo" -> "Foo"
     *   "def create_foo() -> Foo:" -> "Foo"
     */
    private extractReturnType(signature: string): string | null {
        // TypeScript-style: ): ReturnType
        const tsMatch = signature.match(/\)\s*:\s*(\w[\w.<>,\s|]*?)(?:\s*\{|$)/);
        if (tsMatch && tsMatch[1]) {
            const types = this.parseUnionType(tsMatch[1]);
            return types.length > 0 ? (types[0] ?? null) : null;
        }

        // Python-style: -> ReturnType
        const pyMatch = signature.match(/->\s*(\w[\w.,\s|]*?)(?:\s*:|$)/);
        if (pyMatch && pyMatch[1]) {
            const types = this.parseUnionType(pyMatch[1]);
            return types.length > 0 ? (types[0] ?? null) : null;
        }

        return null;
    }

    // -----------------------------------------------------------------------
    // 3. MEMBER CALLSITE EXTRACTION
    // -----------------------------------------------------------------------

    /**
     * Extract all member-access callsites from source bodies.
     * Returns callsites like: { callerSvId, receiverExpression: "self.service.validate", ... }
     */
    private extractMemberCallsites(svRows: SymbolVersionRow[]): MemberCallsite[] {
        const callsites: MemberCallsite[] = [];

        for (const sv of svRows) {
            if (sv.kind !== 'method' && sv.kind !== 'function') continue;
            const source = sv.body_source;
            if (!source) continue;

            const lines = source.split('\n');
            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx] ?? '';

                // Match this.x.y.z() or self.x.y.z() chains
                let match: RegExpExecArray | null;
                const chainRe = new RegExp(MEMBER_CHAIN_CALL_RE.source, 'g');
                while ((match = chainRe.exec(line)) !== null) {
                    const chainGroup = match[1];
                    if (!chainGroup) continue;
                    const chainPart = chainGroup.replace(/\s+/g, '');
                    const segments = chainPart.split('.').filter(s => s.length > 0);
                    if (segments.length === 0) continue;

                    const methodName = segments[segments.length - 1] ?? segments[0] ?? '';
                    const receiverExpression = 'self' + chainPart;

                    callsites.push({
                        callerSvId: sv.symbol_version_id,
                        receiverExpression,
                        methodName,
                        line: sv.range_start_line + lineIdx,
                    });
                }
            }
        }

        return callsites;
    }

    // -----------------------------------------------------------------------
    // 4. CHAINED MEMBER ACCESS RESOLUTION
    // -----------------------------------------------------------------------

    /**
     * Resolve a single member access chain (e.g., "self.service.repository.find").
     *
     * Walks each segment:
     *   1. "self" -> look up the containing class
     *   2. "service" -> look up field "service" in points-to facts
     *   3. "repository" -> look up field "repository" on the service type
     *   4. "find" -> look up method "find" on the repository type
     *
     * Returns a DispatchResolution with all intermediate types and the final targets.
     */
    async resolveChain(
        snapshotId: string,
        callerSvId: string,
        chain: string,
    ): Promise<DispatchResolution> {
        const timer = log.startTimer('resolveChain', { snapshotId, callerSvId, chain });

        const segments = chain.replace(/^(this|self)\./, '').split('.');
        if (segments.length === 0) {
            const result: DispatchResolution = {
                chain,
                segments: [],
                final_receiver_types: [],
                resolved_symbol_version_ids: [],
                resolution_method: RESOLUTION.UNRESOLVED,
                confidence: 0,
                is_polymorphic: false,
                unresolved_reason: 'Empty chain',
            };
            timer({ resolved: false });
            return result;
        }

        // Load snapshot context
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);
        const svById = new Map<string, SymbolVersionRow>();
        const svByCanonical = DispatchResolver.buildCanonicalMap(svRows);
        for (const sv of svRows) {
            svById.set(sv.symbol_version_id, sv);
        }

        // Get the caller's owning class
        const callerSv = svById.get(callerSvId);
        if (!callerSv) {
            const result: DispatchResolution = {
                chain,
                segments: [],
                final_receiver_types: [],
                resolved_symbol_version_ids: [],
                resolution_method: RESOLUTION.UNRESOLVED,
                confidence: 0,
                is_polymorphic: false,
                unresolved_reason: 'Caller symbol version not found',
            };
            timer({ resolved: false });
            return result;
        }

        // Find owning class — extract from stable_key (format: "file#Class.method")
        // canonical_name may be just "method" without class prefix (TS adapter behavior)
        let ownerCanonical: string | null = null;
        if (callerSv.kind === 'method') {
            // First try canonical_name (Python adapter uses Class.method format)
            const dotIdx = callerSv.canonical_name.lastIndexOf('.');
            if (dotIdx !== -1) {
                ownerCanonical = callerSv.canonical_name.substring(0, dotIdx);
            } else {
                // Fallback: extract from stable_key "file#Class.method" or "file#Namespace.Class.method"
                const stableKey = callerSv.stable_key || '';
                const hashIdx = stableKey.lastIndexOf('#');
                if (hashIdx !== -1) {
                    const afterHash = stableKey.substring(hashIdx + 1);
                    const lastDot = afterHash.lastIndexOf('.');
                    if (lastDot !== -1) {
                        ownerCanonical = afterHash.substring(0, lastDot);
                    }
                }
            }
        }

        // Infer points-to facts for the snapshot
        const pointsToFacts = this.inferPointsToFacts(svRows, svByCanonical);

        // Walk the chain
        const resolvedSegments: ChainSegment[] = [];
        let currentTypes: string[] = ownerCanonical ? [ownerCanonical] : [];
        let currentSvIds: string[] = [];
        let overallConfidence = 1.0;
        let lastResolutionMethod: string = RESOLUTION.UNRESOLVED;
        let unresolvedReason: string | null = null;

        const callerFileId = callerSv?.file_id;

        if (ownerCanonical) {
            const ownerSv = DispatchResolver.svByCanonicalInFile(svByCanonical, ownerCanonical, callerFileId);
            if (ownerSv) {
                currentSvIds = [ownerSv.symbol_version_id];
            }
        }

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i] as string | undefined;
            if (!segment) continue;
            const isLast = i === segments.length - 1;

            let segmentTypes: string[] = [];
            let segmentSvIds: string[] = [];
            let segmentMethod: string = RESOLUTION.UNRESOLVED;
            let segmentConfidence = 0;

            // Try to resolve this segment from all current possible types
            for (const currentType of currentTypes) {
                const currentTypeSv = DispatchResolver.svByCanonicalFirst(svByCanonical, currentType);
                if (!currentTypeSv) continue;

                const typeFacts = pointsToFacts.get(currentTypeSv.symbol_version_id);

                // If this is a field access (not last, or last but could be a field)
                if (typeFacts) {
                    const fact = typeFacts.get(segment);
                    if (fact) {
                        segmentTypes.push(...fact.possibleTypes);
                        segmentSvIds.push(...fact.allocationSvIds);
                        segmentMethod = fact.source;
                        segmentConfidence = Math.max(segmentConfidence, fact.confidence);
                    }
                }

                // If this is the last segment, also check for methods
                if (isLast) {
                    // Check class methods directly
                    const methodName = `${currentType}.${segment}`;
                    const methodSv = DispatchResolver.svByCanonicalInFile(svByCanonical, methodName, callerFileId);
                    if (methodSv) {
                        if (!segmentSvIds.includes(methodSv.symbol_version_id)) {
                            segmentSvIds.push(methodSv.symbol_version_id);
                        }
                        if (!segmentTypes.includes(currentType)) {
                            segmentTypes.push(currentType);
                        }
                        segmentMethod = RESOLUTION.TYPE_ANNOTATION;
                        segmentConfidence = Math.max(segmentConfidence, 0.90);
                    }

                    // Check MRO for inherited methods
                    if (segmentSvIds.length === 0) {
                        const mro = await this.getMRO(snapshotId, currentTypeSv.symbol_version_id);
                        for (const ancestorId of mro) {
                            const ancestorSv = svById.get(ancestorId);
                            if (!ancestorSv) continue;
                            const inheritedMethodName = `${ancestorSv.canonical_name}.${segment}`;
                            const inheritedMethodSv = DispatchResolver.svByCanonicalFirst(svByCanonical, inheritedMethodName);
                            if (inheritedMethodSv) {
                                if (!segmentSvIds.includes(inheritedMethodSv.symbol_version_id)) {
                                    segmentSvIds.push(inheritedMethodSv.symbol_version_id);
                                }
                                if (!segmentTypes.includes(ancestorSv.canonical_name)) {
                                    segmentTypes.push(ancestorSv.canonical_name);
                                }
                                segmentMethod = RESOLUTION.INHERITANCE_MRO;
                                segmentConfidence = Math.max(segmentConfidence, 0.85);
                                break; // MRO gives first match
                            }
                        }
                    }
                }

                // If not found as field or method, check for type annotation on the segment
                if (segmentTypes.length === 0) {
                    // Try looking up as a nested canonical name
                    const nestedName = `${currentType}.${segment}`;
                    const nestedSv = DispatchResolver.svByCanonicalFirst(svByCanonical, nestedName);
                    if (nestedSv) {
                        segmentTypes.push(nestedSv.canonical_name);
                        segmentSvIds.push(nestedSv.symbol_version_id);
                        segmentMethod = RESOLUTION.FIELD_INFERENCE;
                        segmentConfidence = Math.max(segmentConfidence, 0.70);
                    }
                }
            }

            // Deduplicate
            segmentTypes = [...new Set(segmentTypes)];
            segmentSvIds = [...new Set(segmentSvIds)];

            resolvedSegments.push({
                segment,
                inferred_types: segmentTypes,
                resolution_method: segmentMethod,
                confidence: segmentConfidence,
            });

            // -----------------------------------------------------------------
            // Same-class method resolution: when the chain is `self.METHOD`
            // (single segment after stripping this/self) and the caller is a
            // method, resolve METHOD against the caller's owning class.
            // This handles the most common OOP pattern: this.method() /
            // self.method() calling another method on the same class without
            // any field-level points-to fact.
            // Works for TypeScript (this.), Python (self.), Rust (self.),
            // Java/C# (this.).
            // -----------------------------------------------------------------
            if (segmentTypes.length === 0 && segmentSvIds.length === 0
                && ownerCanonical && segments.length === 1) {
                // Try qualified name first: ClassName.methodName
                const qualifiedName = `${ownerCanonical}.${segment}`;
                const qualifiedSv = DispatchResolver.svByCanonicalInFile(svByCanonical, qualifiedName, callerFileId);
                // Also try bare name: methodName (TS/universal adapters store methods without class prefix)
                const bareSv = !qualifiedSv ? DispatchResolver.svByCanonicalInFile(svByCanonical, segment, callerFileId) : undefined;
                const resolvedSameClassSv = qualifiedSv || bareSv;
                if (resolvedSameClassSv) {
                    segmentSvIds.push(resolvedSameClassSv.symbol_version_id);
                    segmentTypes.push(ownerCanonical);
                    segmentMethod = RESOLUTION.FIELD_INFERENCE;
                    segmentConfidence = qualifiedSv ? 0.85 : 0.80;

                    // Update the already-pushed segment record
                    const lastSeg = resolvedSegments[resolvedSegments.length - 1];
                    if (lastSeg) {
                        lastSeg.inferred_types = segmentTypes;
                        lastSeg.resolution_method = segmentMethod;
                        lastSeg.confidence = segmentConfidence;
                    }
                }
            }

            if (segmentTypes.length === 0 && segmentSvIds.length === 0) {
                unresolvedReason = `Cannot resolve segment "${segment}" at position ${i} in chain "${chain}"`;
                overallConfidence *= 0.3;
                lastResolutionMethod = RESOLUTION.UNRESOLVED;
                break;
            }

            overallConfidence *= segmentConfidence;
            lastResolutionMethod = segmentMethod;
            currentTypes = segmentTypes;
            currentSvIds = segmentSvIds;
        }

        const isPolymorphic = currentSvIds.length > 1;
        const finalConfidence = Math.max(0.05, overallConfidence);

        const result: DispatchResolution = {
            chain,
            segments: resolvedSegments,
            final_receiver_types: currentTypes,
            resolved_symbol_version_ids: currentSvIds,
            resolution_method: lastResolutionMethod,
            confidence: finalConfidence,
            is_polymorphic: isPolymorphic,
            unresolved_reason: unresolvedReason,
        };

        timer({
            resolved: currentSvIds.length > 0,
            targets: currentSvIds.length,
            confidence: finalConfidence,
        });

        return result;
    }

    // -----------------------------------------------------------------------
    // 5. FULL SNAPSHOT DISPATCH RESOLUTION
    // -----------------------------------------------------------------------

    /**
     * Resolve all dispatch edges in a snapshot.
     *
     * This is the main entry point. It:
     *   1. Builds/refreshes the class hierarchy
     *   2. Infers points-to facts for all classes
     *   3. Extracts member-access callsites from all method/function bodies
     *   4. Resolves each callsite chain
     *   5. Persists dispatch_edges
     *
     * Returns the number of dispatch edges created.
     */
    async resolveDispatches(snapshotId: string, repoId: string): Promise<number> {
        const timer = log.startTimer('resolveDispatches', { snapshotId, repoId });

        // Step 1: Build class hierarchy
        const hierarchyCount = await this.buildClassHierarchy(snapshotId);
        log.info('Class hierarchy built', { snapshotId, hierarchyCount });

        // Step 2: Load all symbol versions and infer points-to facts
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);
        const svById = new Map<string, SymbolVersionRow>();
        const svByCanonical = DispatchResolver.buildCanonicalMap(svRows);
        for (const sv of svRows) {
            svById.set(sv.symbol_version_id, sv);
        }

        const pointsToFacts = this.inferPointsToFacts(svRows, svByCanonical);
        log.info('Points-to facts inferred', {
            snapshotId,
            classes_with_facts: pointsToFacts.size,
            total_fields: Array.from(pointsToFacts.values()).reduce((sum, m) => sum + m.size, 0),
        });

        // Step 3: Extract member-access callsites
        const callsites = this.extractMemberCallsites(svRows);
        log.info('Member callsites extracted', { snapshotId, count: callsites.length });

        if (callsites.length === 0) {
            timer({ dispatch_edges: 0 });
            return 0;
        }

        // Step 4: Resolve each callsite
        // The DELETE is prepended to the batch insert statements below so the entire
        // DELETE + INSERT sequence is atomic within a single transaction.

        // Build a MRO cache for all classes in this snapshot
        const mroCache = new Map<string, string[]>();
        for (const sv of svRows) {
            if (sv.kind === 'class' || sv.kind === 'interface') {
                const mro = await this.getMROFromDB(snapshotId, sv.symbol_version_id);
                mroCache.set(sv.symbol_version_id, mro);
            }
        }

        // Resolve callsites in bulk using in-memory data
        // Prepend DELETE so the entire sequence (delete old + insert new) is atomic
        const statements: { text: string; params: unknown[] }[] = [{
            text: `DELETE FROM dispatch_edges WHERE snapshot_id = $1`,
            params: [snapshotId],
        }];
        let resolvedCount = 0;
        let unresolvedCount = 0;

        for (const callsite of callsites) {
            const resolution = await this.resolveCallsiteInMemory(
                callsite,
                svById,
                svByCanonical,
                pointsToFacts,
                mroCache,
                snapshotId,
            );

            // Compute override chain for resolved targets
            let overrideChain: string[] | null = null;
            let hierarchyDepth: number | null = null;

            if (resolution.resolved_symbol_version_ids.length > 0 &&
                resolution.resolution_method === RESOLUTION.INHERITANCE_MRO) {
                overrideChain = await this.getOverrideChain(
                    snapshotId,
                    resolution.final_receiver_types,
                    resolution.segments[resolution.segments.length - 1]?.segment ?? '',
                    svByCanonical,
                    mroCache,
                    svById,
                );
                hierarchyDepth = overrideChain ? overrideChain.length : null;
            }

            statements.push({
                text: `INSERT INTO dispatch_edges (
                           dispatch_edge_id, snapshot_id, caller_symbol_version_id,
                           receiver_expression, receiver_types, resolved_symbol_version_ids,
                           resolution_method, confidence, is_polymorphic,
                           class_hierarchy_depth, override_chain)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                       ON CONFLICT (snapshot_id, caller_symbol_version_id, receiver_expression)
                       DO UPDATE SET
                           receiver_types = EXCLUDED.receiver_types,
                           resolved_symbol_version_ids = EXCLUDED.resolved_symbol_version_ids,
                           resolution_method = EXCLUDED.resolution_method,
                           confidence = EXCLUDED.confidence,
                           is_polymorphic = EXCLUDED.is_polymorphic,
                           class_hierarchy_depth = EXCLUDED.class_hierarchy_depth,
                           override_chain = EXCLUDED.override_chain`,
                params: [
                    uuidv4(),
                    snapshotId,
                    callsite.callerSvId,
                    callsite.receiverExpression,
                    resolution.final_receiver_types,
                    resolution.resolved_symbol_version_ids,
                    resolution.resolution_method,
                    resolution.confidence,
                    resolution.is_polymorphic,
                    hierarchyDepth,
                    overrideChain,
                ],
            });

            if (resolution.resolved_symbol_version_ids.length > 0) {
                resolvedCount++;
            } else {
                unresolvedCount++;
            }
        }

        // Batch insert dispatch edges
        if (statements.length > 0) {
            const CHUNK = 2000;
            for (let i = 0; i < statements.length; i += CHUNK) {
                await db.batchInsert(statements.slice(i, i + CHUNK));
            }
        }

        // statements[0] is the DELETE; actual dispatch edges are the rest
        const edgeCount = statements.length - 1;

        timer({
            dispatch_edges: edgeCount,
            resolved: resolvedCount,
            unresolved: unresolvedCount,
        });

        return edgeCount;
    }

    /**
     * Resolve a callsite using in-memory data (no DB round-trips).
     *
     * Same logic as resolveChain but avoids per-callsite DB queries
     * by operating over pre-loaded data structures.
     */
    private async resolveCallsiteInMemory(
        callsite: MemberCallsite,
        svById: Map<string, SymbolVersionRow>,
        svByCanonical: Map<string, SymbolVersionRow[]>,
        pointsToFacts: Map<string, Map<string, PointsToFact>>,
        mroCache: Map<string, string[]>,
        _snapshotId: string,
    ): Promise<DispatchResolution> {
        const chain = callsite.receiverExpression;
        const segments = chain.replace(/^(this|self)\./, '').split('.');

        if (segments.length === 0) {
            return {
                chain,
                segments: [],
                final_receiver_types: [],
                resolved_symbol_version_ids: [],
                resolution_method: RESOLUTION.UNRESOLVED,
                confidence: 0,
                is_polymorphic: false,
                unresolved_reason: 'Empty chain',
            };
        }

        // Find caller's owning class
        const callerSv = svById.get(callsite.callerSvId);
        if (!callerSv) {
            return {
                chain,
                segments: [],
                final_receiver_types: [],
                resolved_symbol_version_ids: [],
                resolution_method: RESOLUTION.UNRESOLVED,
                confidence: 0,
                is_polymorphic: false,
                unresolved_reason: 'Caller not found',
            };
        }

        let ownerCanonical: string | null = null;
        if (callerSv.kind === 'method') {
            const dotIdx = callerSv.canonical_name.lastIndexOf('.');
            if (dotIdx !== -1) {
                ownerCanonical = callerSv.canonical_name.substring(0, dotIdx);
            } else {
                // Fallback: extract from stable_key "file#Class.method"
                const stableKey = callerSv.stable_key || '';
                const hashIdx = stableKey.lastIndexOf('#');
                if (hashIdx !== -1) {
                    const afterHash = stableKey.substring(hashIdx + 1);
                    const lastDot = afterHash.lastIndexOf('.');
                    if (lastDot !== -1) {
                        ownerCanonical = afterHash.substring(0, lastDot);
                    }
                }
            }
        } else if (callerSv.kind === 'class') {
            ownerCanonical = callerSv.canonical_name;
        }

        let currentTypes: string[] = ownerCanonical ? [ownerCanonical] : [];
        let currentSvIds: string[] = [];
        const resolvedSegments: ChainSegment[] = [];
        let overallConfidence = 1.0;
        let lastResolutionMethod: string = RESOLUTION.UNRESOLVED;
        let unresolvedReason: string | null = null;

        const callerFileId = callerSv?.file_id;

        if (ownerCanonical) {
            const ownerSv = DispatchResolver.svByCanonicalInFile(svByCanonical, ownerCanonical, callerFileId);
            if (ownerSv) currentSvIds = [ownerSv.symbol_version_id];
        }

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i] as string | undefined;
            if (!segment) continue;
            const isLast = i === segments.length - 1;

            let segmentTypes: string[] = [];
            let segmentSvIds: string[] = [];
            let segmentMethod: string = RESOLUTION.UNRESOLVED;
            let segmentConfidence = 0;

            for (const currentType of currentTypes) {
                const currentTypeSv = DispatchResolver.svByCanonicalFirst(svByCanonical, currentType);
                if (!currentTypeSv) continue;

                // Field access via points-to facts
                const typeFacts = pointsToFacts.get(currentTypeSv.symbol_version_id);
                if (typeFacts) {
                    const fact = typeFacts.get(segment);
                    if (fact) {
                        segmentTypes.push(...fact.possibleTypes);
                        segmentSvIds.push(...fact.allocationSvIds);
                        segmentMethod = fact.source;
                        segmentConfidence = Math.max(segmentConfidence, fact.confidence);
                    }
                }

                // Method resolution on last segment
                if (isLast) {
                    const methodName = `${currentType}.${segment}`;
                    const methodSv = DispatchResolver.svByCanonicalInFile(svByCanonical, methodName, callerFileId);
                    if (methodSv) {
                        if (!segmentSvIds.includes(methodSv.symbol_version_id)) {
                            segmentSvIds.push(methodSv.symbol_version_id);
                        }
                        if (!segmentTypes.includes(currentType)) {
                            segmentTypes.push(currentType);
                        }
                        segmentMethod = RESOLUTION.TYPE_ANNOTATION;
                        segmentConfidence = Math.max(segmentConfidence, 0.90);
                    }

                    // MRO-based inherited method lookup
                    if (segmentSvIds.length === 0) {
                        const mro = mroCache.get(currentTypeSv.symbol_version_id) || [];
                        for (const ancestorId of mro) {
                            const ancestorSv = svById.get(ancestorId);
                            if (!ancestorSv) continue;
                            const inheritedMethodName = `${ancestorSv.canonical_name}.${segment}`;
                            const inheritedMethodSv = DispatchResolver.svByCanonicalFirst(svByCanonical, inheritedMethodName);
                            if (inheritedMethodSv) {
                                if (!segmentSvIds.includes(inheritedMethodSv.symbol_version_id)) {
                                    segmentSvIds.push(inheritedMethodSv.symbol_version_id);
                                }
                                if (!segmentTypes.includes(ancestorSv.canonical_name)) {
                                    segmentTypes.push(ancestorSv.canonical_name);
                                }
                                segmentMethod = RESOLUTION.INHERITANCE_MRO;
                                segmentConfidence = Math.max(segmentConfidence, 0.85);
                                break;
                            }
                        }
                    }
                }

                // Nested canonical name fallback
                if (segmentTypes.length === 0) {
                    const nestedName = `${currentType}.${segment}`;
                    const nestedSv = DispatchResolver.svByCanonicalFirst(svByCanonical, nestedName);
                    if (nestedSv) {
                        segmentTypes.push(nestedSv.canonical_name);
                        segmentSvIds.push(nestedSv.symbol_version_id);
                        segmentMethod = RESOLUTION.FIELD_INFERENCE;
                        segmentConfidence = Math.max(segmentConfidence, 0.70);
                    }
                }
            }

            segmentTypes = [...new Set(segmentTypes)];
            segmentSvIds = [...new Set(segmentSvIds)];

            resolvedSegments.push({
                segment,
                inferred_types: segmentTypes,
                resolution_method: segmentMethod,
                confidence: segmentConfidence,
            });

            // -----------------------------------------------------------------
            // Same-class method resolution: when the chain is `self.METHOD`
            // (single segment after stripping this/self) and the caller is a
            // method, resolve METHOD against the caller's owning class.
            // This handles the most common OOP pattern: this.method() /
            // self.method() calling another method on the same class without
            // any field-level points-to fact.
            // Works for TypeScript (this.), Python (self.), Rust (self.),
            // Java/C# (this.).
            // -----------------------------------------------------------------
            if (segmentTypes.length === 0 && segmentSvIds.length === 0
                && ownerCanonical && segments.length === 1) {
                // Try qualified name first: ClassName.methodName
                const qualifiedName = `${ownerCanonical}.${segment}`;
                const qualifiedSv = DispatchResolver.svByCanonicalInFile(svByCanonical, qualifiedName, callerFileId);
                // Also try bare name: methodName (TS/universal adapters store methods without class prefix)
                const bareSv = !qualifiedSv ? DispatchResolver.svByCanonicalInFile(svByCanonical, segment, callerFileId) : undefined;
                const resolvedSameClassSv = qualifiedSv || bareSv;
                if (resolvedSameClassSv) {
                    segmentSvIds.push(resolvedSameClassSv.symbol_version_id);
                    segmentTypes.push(ownerCanonical);
                    segmentMethod = RESOLUTION.FIELD_INFERENCE;
                    segmentConfidence = qualifiedSv ? 0.85 : 0.80;

                    // Update the already-pushed segment record
                    const lastSeg = resolvedSegments[resolvedSegments.length - 1];
                    if (lastSeg) {
                        lastSeg.inferred_types = segmentTypes;
                        lastSeg.resolution_method = segmentMethod;
                        lastSeg.confidence = segmentConfidence;
                    }
                }
            }

            if (segmentTypes.length === 0 && segmentSvIds.length === 0) {
                unresolvedReason = `Cannot resolve segment "${segment}" at position ${i} in chain "${chain}"`;
                overallConfidence *= 0.3;
                lastResolutionMethod = RESOLUTION.UNRESOLVED;
                break;
            }

            overallConfidence *= segmentConfidence;
            lastResolutionMethod = segmentMethod;
            currentTypes = segmentTypes;
            currentSvIds = segmentSvIds;
        }

        const isPolymorphic = currentSvIds.length > 1;

        return {
            chain,
            segments: resolvedSegments,
            final_receiver_types: currentTypes,
            resolved_symbol_version_ids: currentSvIds,
            resolution_method: lastResolutionMethod,
            confidence: Math.max(0.05, overallConfidence),
            is_polymorphic: isPolymorphic,
            unresolved_reason: unresolvedReason,
        };
    }

    /**
     * Get the override chain for a method across the class hierarchy.
     *
     * Given receiver types, a method name, and the MRO cache, return all
     * symbol_version_ids that define or override the method in MRO order.
     */
    private async getOverrideChain(
        snapshotId: string,
        receiverTypes: string[],
        methodSegment: string,
        svByCanonical: Map<string, SymbolVersionRow[]>,
        mroCache: Map<string, string[]>,
        svById: Map<string, SymbolVersionRow>,
    ): Promise<string[]> {
        const chain: string[] = [];
        const seen = new Set<string>();

        for (const receiverType of receiverTypes) {
            const receiverSv = DispatchResolver.svByCanonicalFirst(svByCanonical, receiverType);
            if (!receiverSv) continue;

            const mro = mroCache.get(receiverSv.symbol_version_id) || [];

            for (const ancestorId of mro) {
                const ancestorSv = svById.get(ancestorId);
                if (!ancestorSv) continue;

                const methodName = `${ancestorSv.canonical_name}.${methodSegment}`;
                const methodSv = DispatchResolver.svByCanonicalFirst(svByCanonical, methodName);
                if (methodSv && !seen.has(methodSv.symbol_version_id)) {
                    seen.add(methodSv.symbol_version_id);
                    chain.push(methodSv.symbol_version_id);
                }
            }
        }

        return chain;
    }

    // -----------------------------------------------------------------------
    // 6. MRO QUERIES
    // -----------------------------------------------------------------------

    /**
     * Get Method Resolution Order for a class.
     *
     * First tries the class_hierarchy table (pre-computed).
     * Falls back to computing from structural_relations if not cached.
     *
     * Returns ordered list of symbol_version_ids from self to most distant ancestor.
     */
    async getMRO(snapshotId: string, classSvId: string): Promise<string[]> {
        const timer = log.startTimer('getMRO', { snapshotId, classSvId });

        const mro = await this.getMROFromDB(snapshotId, classSvId);

        if (mro.length > 0) {
            timer({ source: 'db', depth: mro.length });
            return mro;
        }

        // Fallback: compute from structural_relations on the fly
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);

        // Load inheritance relations
        const relResult = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id, sr.relation_type
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
            AND sr.relation_type IN ('inherits', 'implements')
        `, [snapshotId]);

        const graph = new Map<string, ClassNode>();
        for (const sv of svRows) {
            if (sv.kind === 'class' || sv.kind === 'interface') {
                graph.set(sv.symbol_version_id, {
                    symbolVersionId: sv.symbol_version_id,
                    symbolId: sv.symbol_id,
                    canonicalName: sv.canonical_name,
                    kind: sv.kind,
                    parents: [],
                    children: [],
                    methods: new Map(),
                });
            }
        }

        for (const row of relResult.rows as { src_symbol_version_id: string; dst_symbol_version_id: string; relation_type: string }[]) {
            const childNode = graph.get(row.src_symbol_version_id);
            if (childNode) {
                childNode.parents.push({
                    svId: row.dst_symbol_version_id,
                    relationKind: row.relation_type === 'inherits' ? 'extends' : 'implements',
                });
            }
        }

        const computed = this.computeC3Linearization(classSvId, graph);
        timer({ source: 'computed', depth: computed.length });
        return computed;
    }

    /**
     * Read MRO from the class_hierarchy table.
     */
    private async getMROFromDB(snapshotId: string, classSvId: string): Promise<string[]> {
        const result = await db.query(`
            SELECT class_symbol_version_id, parent_symbol_version_id, mro_position
            FROM class_hierarchy
            WHERE snapshot_id = $1 AND class_symbol_version_id = $2
            ORDER BY mro_position ASC
        `, [snapshotId, classSvId]);

        if (result.rows.length === 0) return [];

        const mro: string[] = [];
        for (const row of result.rows as { class_symbol_version_id: string; parent_symbol_version_id: string | null; mro_position: number }[]) {
            if (row.mro_position === 0) {
                mro.push(row.class_symbol_version_id);
            } else if (row.parent_symbol_version_id) {
                mro.push(row.parent_symbol_version_id);
            }
        }

        return mro;
    }

    // -----------------------------------------------------------------------
    // 7. DISPATCH EDGE QUERIES
    // -----------------------------------------------------------------------

    /**
     * Get all dispatch edges for a given caller symbol version.
     */
    async getDispatchEdges(callerSvId: string): Promise<DispatchEdge[]> {
        const timer = log.startTimer('getDispatchEdges', { callerSvId });

        const result = await db.query(`
            SELECT dispatch_edge_id, snapshot_id, caller_symbol_version_id,
                   receiver_expression, receiver_types, resolved_symbol_version_ids,
                   resolution_method, confidence, is_polymorphic,
                   class_hierarchy_depth, override_chain, created_at
            FROM dispatch_edges
            WHERE caller_symbol_version_id = $1
            ORDER BY confidence DESC
        `, [callerSvId]);

        const edges = result.rows as DispatchEdge[];
        timer({ count: edges.length });
        return edges;
    }

    /**
     * Get all dispatch edges targeting a specific resolved symbol.
     * Useful for reverse lookup: "who dispatches to this method?"
     */
    async getDispatchersOf(targetSvId: string): Promise<DispatchEdge[]> {
        const timer = log.startTimer('getDispatchersOf', { targetSvId });

        const result = await db.query(`
            SELECT dispatch_edge_id, snapshot_id, caller_symbol_version_id,
                   receiver_expression, receiver_types, resolved_symbol_version_ids,
                   resolution_method, confidence, is_polymorphic,
                   class_hierarchy_depth, override_chain, created_at
            FROM dispatch_edges
            WHERE $1 = ANY(resolved_symbol_version_ids)
            ORDER BY confidence DESC
        `, [targetSvId]);

        const edges = result.rows as DispatchEdge[];
        timer({ count: edges.length });
        return edges;
    }

    /**
     * Get all unresolved dispatch edges in a snapshot.
     * Useful for uncertainty tracking and analysis gaps.
     */
    async getUnresolvedDispatches(snapshotId: string): Promise<DispatchEdge[]> {
        const timer = log.startTimer('getUnresolvedDispatches', { snapshotId });

        const result = await db.query(`
            SELECT dispatch_edge_id, snapshot_id, caller_symbol_version_id,
                   receiver_expression, receiver_types, resolved_symbol_version_ids,
                   resolution_method, confidence, is_polymorphic,
                   class_hierarchy_depth, override_chain, created_at
            FROM dispatch_edges
            WHERE snapshot_id = $1
            AND resolution_method = $2
            ORDER BY receiver_expression
        `, [snapshotId, RESOLUTION.UNRESOLVED]);

        const edges = result.rows as DispatchEdge[];
        timer({ count: edges.length });
        return edges;
    }

    /**
     * Get dispatch resolution statistics for a snapshot.
     */
    async getDispatchStats(snapshotId: string): Promise<{
        total_edges: number;
        resolved_edges: number;
        unresolved_edges: number;
        polymorphic_edges: number;
        resolution_methods: Record<string, number>;
        avg_confidence: number;
    }> {
        const timer = log.startTimer('getDispatchStats', { snapshotId });

        const result = await db.query(`
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE resolution_method != $2) as resolved,
                COUNT(*) FILTER (WHERE resolution_method = $2) as unresolved,
                COUNT(*) FILTER (WHERE is_polymorphic = TRUE) as polymorphic,
                COALESCE(AVG(confidence), 0) as avg_confidence
            FROM dispatch_edges
            WHERE snapshot_id = $1
        `, [snapshotId, RESOLUTION.UNRESOLVED]);

        const row = result.rows[0] as {
            total: string;
            resolved: string;
            unresolved: string;
            polymorphic: string;
            avg_confidence: string;
        };

        // Per-method breakdown
        const methodResult = await db.query(`
            SELECT resolution_method, COUNT(*) as cnt
            FROM dispatch_edges
            WHERE snapshot_id = $1
            GROUP BY resolution_method
            ORDER BY cnt DESC
        `, [snapshotId]);

        const resolutionMethods: Record<string, number> = {};
        for (const r of methodResult.rows as { resolution_method: string; cnt: string }[]) {
            resolutionMethods[r.resolution_method] = parseInt(r.cnt, 10);
        }

        const stats = {
            total_edges: parseInt(row.total, 10),
            resolved_edges: parseInt(row.resolved, 10),
            unresolved_edges: parseInt(row.unresolved, 10),
            polymorphic_edges: parseInt(row.polymorphic, 10),
            resolution_methods: resolutionMethods,
            avg_confidence: parseFloat(row.avg_confidence),
        };

        timer(stats);
        return stats;
    }

    /**
     * Get the full class hierarchy tree for a snapshot.
     * Returns a map: class_svId -> ordered list of ancestor svIds (MRO).
     */
    async getFullHierarchy(snapshotId: string): Promise<Map<string, string[]>> {
        const timer = log.startTimer('getFullHierarchy', { snapshotId });

        const result = await db.query(`
            SELECT class_symbol_version_id, parent_symbol_version_id, mro_position
            FROM class_hierarchy
            WHERE snapshot_id = $1
            ORDER BY class_symbol_version_id, mro_position ASC
        `, [snapshotId]);

        const hierarchy = new Map<string, string[]>();

        for (const row of result.rows as { class_symbol_version_id: string; parent_symbol_version_id: string | null; mro_position: number }[]) {
            if (!hierarchy.has(row.class_symbol_version_id)) {
                hierarchy.set(row.class_symbol_version_id, []);
            }
            const mro = hierarchy.get(row.class_symbol_version_id)!;
            if (row.mro_position === 0) {
                mro.push(row.class_symbol_version_id);
            } else if (row.parent_symbol_version_id) {
                mro.push(row.parent_symbol_version_id);
            }
        }

        timer({ classes: hierarchy.size });
        return hierarchy;
    }
}

export const dispatchResolver = new DispatchResolver();
