# Context Zero V2 — Production Blueprint

## One-Line Definition

Context Zero is a persistent code twin for precise AI-assisted understanding and modification.

## Philosophy

1. **Exactness beats approximation** — anchored to exact symbols, versions, relations, evidence
2. **Semantics are evidence, not truth** — embeddings for candidate generation only, never final authority
3. **Static understanding is necessary but insufficient** — V2 models observed reality too
4. **Identity must survive time** — stable lineage across snapshots and restarts
5. **Contracts exist without tests** — mine from code itself
6. **Changes are graph transactions** — not text edits
7. **Uncertainty is first-class** — exact, inferred, observed, unresolved, contradictory

## V2 Architecture: 8 New Subsystems

### 1. Dispatch Resolver (`dispatch-resolver.ts`)
- Class hierarchy analysis with C3 linearization MRO
- Receiver type inference from constructors, annotations, factories
- Field-sensitive points-to analysis
- Chained member access resolution (`self.service.repo.find()`)
- Dispatch edge creation with confidence and polymorphic flags
- **Tables**: `dispatch_edges`, `class_hierarchy`

### 2. Symbol Lineage (`symbol-lineage.ts`)
- Deterministic identity seeds from (repo, language, kind, ancestry, name, signature, path)
- Cross-snapshot matching: exact seed match + fuzzy rename detection
- Birth/death/rename tracking with confidence scores
- Persistent handles: `cz://repo/module/Class.method#lineage:abc123`
- **Table**: `symbol_lineage` + `symbols.lineage_id` FK

### 3. Effect Engine (`effect-engine.ts`)
- Typed effect signatures: reads/writes/emits/calls/mutates/requires/throws
- Effect classification: pure → reader → writer → io → full_side_effect
- Mining from behavioral profiles, hints, and code patterns
- Transitive effect propagation through call graph
- Effect diffing for change validation
- **Table**: `effect_signatures`

### 4. Deep Contract Synthesis (`deep-contracts.ts`)
- Mine from code body: asserts, guards, type guards, null checks, range checks, regex
- Mine from signatures: parameter types, return types, generics, unions
- Mine from decorators: validation, auth, schema, rate limit
- Mine from ORM/schema definitions
- Cross-symbol pattern mining: family-level invariants
- Closure/nested function contract inference
- **Table**: existing `invariants` (extended source types)

### 5. Concept Families (`concept-families.ts`)
- Connected-component clustering from homolog pairs
- Family type classification by member properties
- Canonical exemplar selection
- Family contract/effect fingerprinting
- Outlier and contradiction detection
- **Tables**: `concept_families`, `concept_family_members`

### 6. Temporal Intelligence (`temporal-engine.ts`)
- Git history mining via `execFileSync('git', [...])`
- Co-change pair analysis with Jaccard coefficient
- Bug-fix hotspot detection from commit messages
- Composite risk scoring: frequency + bugs + regressions + churn + authors
- **Tables**: `temporal_co_changes`, `temporal_risk_scores`

### 7. Runtime Evidence (`runtime-evidence.ts`)
- Trace pack ingestion (test, dev, CI, production)
- Symbol resolution from runtime frames
- Edge merging: observed → structural graph
- Uncertainty reduction from runtime confirmation
- Dynamic route registration capture
- Provenance tracking on all relations
- **Tables**: `runtime_traces`, `runtime_observed_edges`

### 8. Capsule Compiler v2 (`capsule-compiler.ts` upgrade)
- Multi-resolution context: full_source → signature_only → contract_summary → effect_summary → name_only
- Inclusion/exclusion rationale for every node
- Fetch handles for omitted nodes
- Dispatch edges in capsule context
- Effect signatures in capsule
- Concept family members (strict mode)
- Compilation persistence for debugging
- **Table**: `capsule_compilations`

## Data Flow

### Ingestion (enhanced)
1. Files parsed → symbols extracted (unchanged)
2. Structural relations resolved (unchanged)
3. **NEW**: Class hierarchy built → dispatch edges resolved
4. **NEW**: Symbol lineage computed (match with previous snapshot)
5. Behavioral profiles extracted (unchanged)
6. **NEW**: Effect signatures computed from behavioral profiles
7. Contracts extracted (unchanged)
8. **NEW**: Deep contracts mined from code body
9. Semantic embeddings computed (unchanged)
10. Homologs inferred (unchanged)
11. **NEW**: Concept families clustered from homologs
12. **NEW**: Temporal intelligence mined from git history
13. Transitive behavioral propagation (unchanged)
14. **NEW**: Transitive effect propagation

### Runtime Flow (new)
1. Trace pack arrives via MCP tool
2. Frames resolved to symbol lineage
3. Observed edges merged into structural graph
4. Static uncertainties reduced
5. Dispatch edges updated with runtime evidence

### Change Flow (enhanced)
1. Transaction created (unchanged)
2. Capsule compiled with **V2 context** (dispatch, effects, families)
3. Patch applied (unchanged)
4. Incremental re-analysis with **V2 engines**
5. Effect diff + contract diff + behavioral diff (enhanced)
6. Family propagation candidates (new)
7. Validation with effect-aware checks (enhanced)
8. Commit or rollback (unchanged)

## Migration Strategy

- Non-destructive: all V1 tables preserved
- V2 tables added via `007_v2_upgrade.sql`
- V2 engines are additive — V1 still works without V2 data
- Graceful degradation: if V2 tables empty, V1 behavior unchanged
- Progressive enhancement: V2 features activate as data is computed
