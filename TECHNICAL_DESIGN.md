# ContextZero — Technical Design

**Primary objective:** Maximize precision in code understanding and code modification
**Secondary objective:** Reduce cost by reducing unnecessary context and incorrect edits

---

# 1. Executive Summary

ContextZero is a code cognition and change orchestration system designed to provide precise, minimal, validated understanding of a software codebase.

ContextZero is based on one core design principle:

> **AI should reason over exact code symbols and explicit evidence, not over approximate text chunks.**

Traditional code RAG systems fail because they:
- split code into arbitrary text chunks,
- lose symbol boundaries,
- retrieve semantically similar but operationally irrelevant snippets,
- miss disconnected duplicate logic,
- fail to understand contracts and invariants,
- and treat edits as text replacement instead of structured code change.

ContextZero solves this by introducing a native system built around:
1. **exact versioned symbols**
2. **behavioral fingerprints**
3. **contract and invariant modeling**
4. **typed homolog inference across disconnected code**
5. **context capsule compilation**
6. **transactional edit planning, validation, and propagation**

The result is a system where downstream tools can:
- identify the exact symbol that should change,
- receive the smallest sufficient context for the task,
- detect hidden parallel implementations elsewhere in the repo,
- understand what assumptions must remain true,
- compute blast radius before and after edits,
- validate the change against syntax, types, tests, and contracts,
- and safely propose propagation to homologous code.

ContextZero is not a search engine, not a graph toy, and not “embeddings over AST.”
It is a **code reasoning substrate**.

---

# 2. Problem Statement

AI coding systems degrade as codebases grow because the amount of potentially relevant context expands faster than the model’s reliable reasoning capacity.

The current failure modes are:

## 2.1 Structural ambiguity
The AI cannot reliably determine:
- what exact symbol is being referenced,
- which implementation is authoritative,
- which callers and callees matter,
- which types and interfaces constrain the change.

## 2.2 Conceptual fragmentation
Important logic often exists in disconnected places:
- duplicate validators,
- mirrored authorization rules,
- repeated normalization logic,
- parallel serializers,
- copy-pasted business rules.

These do not always share structural dependencies, so call-graph search misses them.

## 2.3 Contract blindness
A change may be syntactically valid but still break:
- test assumptions,
- API response shape,
- schema constraints,
- security expectations,
- business invariants.

## 2.4 Context explosion
When the AI is uncertain, it requests more code. More context leads to:
- higher cost,
- weaker focus,
- greater confusion,
- more hallucinated dependencies,
- more bug-inducing edits.

## 2.5 Unsafe change execution
Standard tool chains often support:
- search,
- read file,
- edit file,
- run tests.

This is too weak. It does not treat a change as:
- a structured object,
- with evidence,
- with predicted impact,
- with propagation requirements,
- and with rollback semantics.

---

# 3. Design Principles

ContextZero is governed by the following principles.

## 3.1 Precision over breadth
The system should prefer:
- exact symbol resolution,
- evidence-backed retrieval,
- minimal sufficient context,
over broad, fuzzy search.

## 3.2 Structure is the anchor
All semantic reasoning must be bound to exact program structure:
- symbol IDs,
- AST ranges,
- type information,
- versioned symbol state.

## 3.3 Semantics are evidence, not truth
Embeddings and semantic similarity are useful for:
- candidate generation,
- ranking,
- inference assistance.

They are not final truth.

## 3.4 Contracts are first-class
The system must model:
- what code is,
- what code does,
- and what code must continue to guarantee.

## 3.5 Changes are transactions
Edits must move through:
- planning,
- application,
- validation,
- blast-radius analysis,
- propagation analysis,
- commit or rollback.

## 3.6 Uncertainty must be explicit
If the system cannot fully resolve something, it must report:
- confidence,
- blind spots,
- unresolved dynamic behavior,
- missing runtime evidence.

## 3.7 Native, not patchwork
ContextZero should not be a loose assembly of search, vectors, and file edits.
Its components must operate under one coherent model.

---

# 4. Goals and Non-Goals

## 4.1 Goals
ContextZero must:

1. Resolve natural-language tasks to exact code symbols.
2. Represent code as versioned graph objects, not text chunks.
3. Infer hidden conceptual peers across disconnected code.
4. Compute multi-dimensional blast radius for proposed or applied changes.
5. Compile minimal context capsules for the consumer.
6. Validate edits through syntax, types, tests, contracts, and semantic diff.
7. Support rollback and safe propagation.
8. Expose all of the above through MCP tools.

## 4.2 Non-Goals
ContextZero will not initially:

1. Fully solve all dynamic runtime behavior in all languages.
2. Replace language-native compilers or type checkers.
3. Automatically self-edit an entire monorepo without review.
4. Guarantee semantic equivalence in reflection-heavy systems with no runtime traces.
5. Support every language equally in v1 implementation.

---

# 5. System Scope

## 5.1 Initial support
Recommended initial target languages:
- TypeScript
- Python

These languages are common, complex enough to prove value, and provide strong tool ecosystems.

## 5.2 Initial repository scope
ContextZero should support:
- single repository
- monorepo with package/module boundaries
- CI-driven reindexing
- local developer workflow
- server-side centralized indexing

## 5.3 Initial task types
ContextZero should support these AI workflows first:
- bug fix
- targeted refactor
- duplicate logic unification
- contract-preserving update
- behavior-aware propagation
- test-aware modification

---

# 6. Core Concepts

## 6.1 Symbol
A symbol is the primary unit of code cognition.

Examples:
- function
- method
- class
- route handler
- validator
- serializer
- query builder
- schema object
- test case
- config object

A symbol is always:
- exact,
- versioned,
- typed,
- structurally located.

## 6.2 Symbol Version
A symbol changes over time. ContextZero stores symbol state by commit or repository snapshot.

## 6.3 Behavioral Fingerprint
A compact, comparable representation of what a symbol does:
- side effects,
- storage access,
- auth behavior,
- validation behavior,
- exception patterns,
- mutation class,
- external dependencies.

## 6.4 Contract
A set of constraints or guarantees associated with a symbol.

Examples:
- input must be normalized email
- output shape must include `userId`
- throws `ValidationError` on malformed input
- route requires admin authorization
- serializer must preserve enum casing

## 6.5 Invariant
A stronger contract that must remain true across changes.

Examples:
- email normalization is lowercase and trimmed
- user IDs are never accepted from client input
- billing updates must be transactional
- API error code must remain stable for clients

## 6.6 Homolog
A symbol not necessarily structurally connected, but strongly related in:
- intent,
- behavior,
- contract,
- repeated business purpose.

Homologs are the formal replacement for “ghost links.”

## 6.7 Context Capsule
A minimal sufficient context package compiled for a specific task or symbol.

## 6.8 Change Transaction
A structured edit operation with:
- target symbols,
- patch set,
- predicted blast radius,
- validation results,
- homolog propagation proposals,
- commit/rollback state.

---

# 7. High-Level Architecture

ContextZero consists of **13 analysis engines** organized into six functional groups.

## 7.1 Symbol Spine Engine (structural graph, dispatch resolver, symbol lineage)
Maintains the exact structural representation of the codebase:
- AST-bound symbols with versioned identity
- call graph with two-pass resolution (in-memory + batch DB fallback)
- inheritance/interface graph with C3 linearization MRO
- dispatch resolution with 9 receiver type inference patterns
- cross-snapshot symbol lineage with 5-signal fuzzy matching
- import/module/package graph

## 7.2 Behavioral Fingerprint Engine (behavioral, effect engine)
Extracts operational behavior:
- 4-tier purity classification (pure → read_only → read_write → side_effecting)
- Kahn's topological sort for transitive propagation
- 9 typed effect kinds (reads, writes, opens, throws, calls_external, logs, emits, normalizes, acquires_lock)
- 60+ framework-aware patterns across 8 languages
- resource access, auth logic, validation rules, exception flow, transaction boundaries

## 7.3 Contract & Invariant Engine (contracts, deep contracts)
Extracts and stores:
- signature contracts (input/output/error/security/serialization)
- deep code-body contract mining (~3,000 lines — boundary checks, null safety, guard clauses, return shape, decorator extraction)
- invariant mining from 6 sources (tests, schemas, behavioral profiles, contract profiles, exception profiles, purity)
- schema constraints and business invariants
- ORM pattern recognition (Prisma, TypeORM, Mongoose, Zod, Yup)

## 7.4 Homolog Inference Engine (homolog engine, concept families, semantic engine)
Creates typed inferred relations using multi-evidence scoring:
- 7-dimension weighted scoring with 5 candidate generation buckets
- Native TF-IDF + MinHash + LSH for semantic similarity (zero external dependencies)
- Concept family clustering with modularity bisection and 10 family types
- Contradiction detection and human review support

## 7.5 Context & Analysis Engines (capsule compiler, blast radius, uncertainty tracker)
- Token-budgeted context compilation in 3 modes with 5-level degradation ladder
- 5-dimensional blast radius (structural, behavioral, contract, homolog, historical) computed in parallel
- 12-source uncertainty model with per-symbol and per-snapshot confidence scoring

## 7.6 Change & Temporal Engines (transactional editor, temporal engine, runtime evidence)
Orchestrates:
- 9-state transaction lifecycle with planning, patching, validation, propagation, commit/rollback
- Git history mining with co-change pair computation (Jaccard similarity) and risk scoring
- Runtime trace ingestion with observed edge persistence and evidence retrieval
- Sandboxed subprocess execution with resource constraints

---

# 8. Detailed Architecture

## 8.1 Architectural flow

### Ingestion path
1. repository event detected
2. changed files mirrored
3. language adapters parse and resolve symbols
4. structural graph updated
5. behavioral profiles extracted
6. contract profiles extracted
7. semantic profiles computed
8. candidate homologs generated
9. homologs reranked and typed
10. indexes refreshed

### Query/change path
1. The consumer requests task planning
2. SCG resolves likely target symbols
3. SCG compiles context capsule
4. The consumer proposes patch
5. SCG applies patch in transaction sandbox
6. SCG computes blast radius
7. SCG validates syntax/types/tests/contracts
8. SCG proposes homolog propagation
9. The consumer or policy chooses commit/rollback

---

# 9. Functional Requirements

## 9.1 Repository ingestion
The system shall:
- accept ingestion requests via API and MCP tools (request-driven, not polling),
- index by commit or content hash,
- support incremental reindexing via changed file list,
- support language-specific symbol extraction across 13 languages.

## 9.2 Exact symbol resolution
The system shall:
- resolve natural-language intent to likely symbols,
- map symbol references to exact code ranges,
- return confidence and ambiguity.

## 9.3 Multi-plane code understanding
The system shall model:
- structure,
- behavior,
- semantics,
- contracts,
- history/risk.

## 9.4 Homolog inference
The system shall infer and store typed homolog relations with evidence bundles.

## 9.5 Blast radius analysis
The system shall compute structural, behavioral, contract, homolog, and historical blast radius.

## 9.6 Context capsule generation
The system shall return minimal sufficient context under a token budget.

## 9.7 Transactional code editing
The system shall support:
- prepare,
- patch apply,
- validation,
- propagation proposal,
- commit,
- rollback.

## 9.8 Uncertainty handling
The system shall expose uncertainty in all major inference and resolution outputs.

---

# 10. Non-Functional Requirements

## 10.1 Precision
Highest priority. The system should minimize:
- wrong target selection,
- irrelevant context,
- unsafe propagation,
- contract-breaking changes.

## 10.2 Explainability
All inferred homologs and blast-radius results must be explainable via evidence.

## 10.3 Incrementality
The system must avoid full reindex unless required.

## 10.4 Performance
Target initial response expectations:
- symbol lookup: sub-second to low seconds
- context capsule compile: low seconds
- blast radius: low seconds to tens of seconds depending on scope
- validation: dependent on build/test workload

## 10.5 Reliability
Failed indexing or failed inference must not corrupt source-of-truth symbol state.

## 10.6 Security
Code execution for validation must be sandboxed.

---

# 11. Data Model

## 11.1 Core entities

### Repository
Represents a source code repository.

Fields:
- `repo_id`
- `name`
- `default_branch`
- `visibility`
- `language_set`
- `created_at`
- `updated_at`

### Snapshot
Represents a repository state, usually by commit.

Fields:
- `snapshot_id`
- `repo_id`
- `commit_sha`
- `branch`
- `parent_snapshot_id`
- `indexed_at`
- `index_status`

### File
Fields:
- `file_id`
- `snapshot_id`
- `path`
- `content_hash`
- `language`
- `parse_status`

### Symbol
Stable identity across versions where possible.

Fields:
- `symbol_id`
- `repo_id`
- `stable_key`
- `canonical_name`
- `kind`
- `logical_namespace`

### SymbolVersion
Exact symbol in a specific snapshot.

Fields:
- `symbol_version_id`
- `symbol_id`
- `snapshot_id`
- `file_id`
- `range_start_line`
- `range_start_col`
- `range_end_line`
- `range_end_col`
- `signature`
- `ast_hash`
- `body_hash`
- `summary`
- `visibility`
- `language`
- `uncertainty_flags`

### StructuralRelation
Examples:
- calls
- called_by
- references
- defines
- imports
- implements
- inherits
- typed_as
- overrides

Fields:
- `relation_id`
- `src_symbol_version_id`
- `dst_symbol_version_id`
- `relation_type`
- `strength`
- `source`
- `confidence`

### BehavioralProfile
Fields:
- `behavior_profile_id`
- `symbol_version_id`
- `purity_class`
- `resource_touches`
- `db_reads`
- `db_writes`
- `network_calls`
- `cache_ops`
- `file_io`
- `auth_operations`
- `validation_operations`
- `exception_profile`
- `state_mutation_profile`
- `transaction_profile`

### ContractProfile
Fields:
- `contract_profile_id`
- `symbol_version_id`
- `input_contract`
- `output_contract`
- `error_contract`
- `schema_refs`
- `api_contract_refs`
- `serialization_contract`
- `security_contract`
- `derived_invariants_count`

### Invariant
Fields:
- `invariant_id`
- `repo_id`
- `scope_symbol_id`
- `scope_level`
- `expression`
- `source_type`
- `strength`
- `validation_method`
- `last_verified_snapshot_id`

### SemanticVector (replaces the earlier SemanticProfile concept)
Sparse TF-IDF vectors and MinHash signatures stored per symbol-version per view.

Fields:
- `vector_id`
- `symbol_version_id`
- `snapshot_id`
- `view_type` (name, body, signature, behavior, contract)
- `sparse_vector` (JSONB — token:weight pairs)
- `minhash_signature` (JSONB — 128-permutation MinHash)

Supporting tables:
- `idf_corpus` — inverse document frequency per snapshot/view_type
- `lsh_bands` — locality-sensitive hashing bands (16 bands x 8 rows) for sub-linear candidate retrieval

### EvidenceBundle
Fields:
- `evidence_bundle_id`
- `semantic_score`
- `structural_score`
- `behavioral_score`
- `contract_score`
- `test_score`
- `history_score`
- `contradiction_flags`
- `feature_payload`
- `generated_at`

### InferredRelation
Examples:
- validator_homolog
- serializer_homolog
- auth_policy_peer
- near_duplicate_logic
- business_rule_parallel
- normalization_homolog
- contract_sibling
- co_changed_with

Fields:
- `inferred_relation_id`
- `src_symbol_version_id`
- `dst_symbol_version_id`
- `relation_type`
- `confidence`
- `review_state`
- `evidence_bundle_id`
- `valid_from_snapshot_id`
- `valid_to_snapshot_id`

### TestArtifact
Fields:
- `test_artifact_id`
- `symbol_version_id`
- `framework`
- `related_symbols`
- `assertion_summary`
- `coverage_hints`

### ChangeTransaction
Fields:
- `txn_id`
- `repo_id`
- `base_snapshot_id`
- `created_by`
- `state`
- `target_symbol_versions`
- `patches`
- `impact_report_ref`
- `validation_report_ref`
- `propagation_report_ref`
- `created_at`
- `updated_at`

---

# 12. Storage Architecture

## 12.1 Implementation

### Relational store
**PostgreSQL 16**
- Source of truth for all entities, relations, transactions, invariants, reports
- Strong consistency with full FK integrity and ON DELETE CASCADE
- 28 active application tables across 13 migrations
- CHECK constraints on all enum columns and score bounds

### Vector similarity
**Native TF-IDF + MinHash + LSH** (implemented in `semantic-engine/`)
- No external vector database required (no pgvector, no Qdrant)
- 5-view tokenization with L2-normalized sparse TF-IDF vectors
- MinHash signatures (128 permutations) with BigInt arithmetic
- LSH banding (16 bands x 8 rows) for sub-linear candidate retrieval
- Cosine similarity for precise scoring

### Lexical/code search
**Native regex + pg_trgm** (implemented in `services/search-service.ts`)
- No external search engine required (no OpenSearch, no Tantivy, no Lucene)
- PostgreSQL `pg_trgm` extension for fuzzy symbol name matching
- Regex pattern search with file-level context lines

### Cache
**In-process LRU with TTL** (implemented in `cache/index.ts`)
- No Redis dependency — sufficient for single-instance deployment
- 5 cache layers: symbol, profile, capsule, homolog, query
- Periodic 60-second cleanup of expired entries
- Prefix-based invalidation on incremental re-indexing

### Processing model
**Synchronous request-driven pipeline**
- No event bus (NATS/Kafka) — ingestion is triggered via API/MCP tools
- All analysis engines run synchronously within the ingestion pipeline
- V2 engines are non-fatal (try/catch wrapped) to prevent partial failures from aborting ingestion

## 12.2 Why not a graph DB as primary store
A graph database is not required as the source of truth. Postgres can model relations efficiently while also giving:
- transactions,
- versioning support,
- easier operations,
- stronger ecosystem fit.

Graph semantics remain a logical model even if physically stored relationally.

---

# 13. Language Adapters

## 13.1 Adapter design
Each language adapter is responsible for:
- parsing
- symbol extraction
- type resolution
- reference extraction
- framework-specific heuristics
- behavior and contract extraction hooks

## 13.2 Implemented adapters

### TypeScript adapter
Uses:
- TypeScript Compiler API (`ts.createProgram`, `ts.TypeChecker`) for project-level type-aware AST parsing
- Full symbol, relation, behavioral hint, and contract hint extraction
- AST normalization for rename-invariant structural comparison

### Python adapter
Uses:
- LibCST with PositionProvider metadata, run as a subprocess via `execFileSync` with array args (command injection safe)
- Structural symbol extraction with behavioral pattern matching

### Universal adapter (tree-sitter)
Supports 11 additional languages: C++, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, Bash, Kotlin
- Language-specific tree-sitter grammars with grammar caching
- Parser pooling for performance
- SHA-256 AST fingerprints with graceful degradation

## 13.3 Adapter output contract
Each adapter must emit normalized structures:
- symbols
- structural relations
- type facts
- behavior hints
- contract hints
- parse confidence
- unresolved dynamic features

---

# 14. Ingestion and Indexing Pipeline

## 14.1 Stage 1: Snapshot acquisition
Trigger sources:
- Manual indexing request via `scg_ingest_repo` (MCP tool or HTTP endpoint)
- Incremental indexing via `scg_incremental_index` with changed file list

Outputs:
- repository snapshot
- changed file set
- dependency invalidation scope

## 14.2 Stage 2: Parsing and symbol extraction
For each changed file:
- parse AST
- recover symbol boundaries
- extract symbol metadata
- resolve stable keys
- map references and scopes

Failure behavior:
- partial indexing allowed
- parse errors recorded
- previous valid snapshot retained

## 14.3 Stage 3: Structural graph build
Build/update:
- symbol table
- import graph
- call graph
- inheritance graph
- type graph
- test linkage graph

## 14.4 Stage 4: Behavioral extraction
Infer:
- side effects
- external resource usage
- auth checks
- validation logic
- mutation patterns
- error behavior
- transaction patterns

Behavior extraction should combine:
- static analysis
- framework heuristics
- optional annotation support

## 14.5 Stage 5: Contract extraction
Pull from:
- function signatures
- return types
- exceptions
- schemas
- route specs
- tests
- assertions
- ORM models
- manual rules

## 14.6 Stage 6: Semantic profiling
Generate per-symbol multi-view TF-IDF vectors with 5 views:
- **name** (weight: 0.25) — compound name splitting, suffix stemming
- **body** (weight: 0.30) — code-body tokenization with noise word removal
- **signature** (weight: 0.20) — parameter and return type tokens
- **behavior** (weight: 0.15) — purity class, resource touches, effect patterns
- **contract** (weight: 0.10) — input/output/error contract tokens

Vectors stored per symbol_version in `semantic_vectors` table with MinHash signatures (128 permutations) and LSH bands (16 bands x 8 rows).

## 14.7 Stage 7: Candidate generation
Generate homolog candidates using 5 buckets:
1. **Body hash exact match** — identical function bodies
2. **AST hash exact match** — structurally identical after normalization
3. **Name similarity** — pg_trgm fuzzy matching on canonical names
4. **Behavioral profile overlap** — shared purity class, resource touches, effect patterns
5. **Contract profile overlap** — shared input/output/error contract patterns

## 14.8 Stage 8: Reranking and relation typing
Candidate pairs are scored and classified into specific inferred relation types.

## 14.9 Stage 9: Incremental invalidation
When a symbol changes:
- invalidate old inferred relations touching that symbol,
- re-evaluate dependent candidates,
- update cached capsules,
- mark stale impact reports.

---

# 15. Homolog Inference Engine

## 15.1 Purpose
The Homolog Inference Engine detects parallel code that should influence AI reasoning even when no direct structural link exists.

## 15.2 Example homolog categories
- `validator_homolog`
- `normalization_homolog`
- `serializer_homolog`
- `auth_policy_peer`
- `query_logic_duplicate`
- `business_rule_parallel`
- `contract_sibling`
- `error_mapping_peer`

## 15.3 Candidate generation strategy
Never perform all-to-all comparison.
Use:
1. semantic nearest neighbors
2. lexical and signature bucket matching
3. AST-normalized clone buckets
4. behavior profile overlap buckets
5. contract profile overlap buckets
6. historical co-change clusters

## 15.4 Scoring model
A weighted multi-evidence model computes confidence.

Example initial weighting:
- semantic intent similarity: 0.20
- normalized logic similarity: 0.20
- signature/type similarity: 0.15
- behavioral overlap: 0.15
- contract overlap: 0.15
- test overlap: 0.10
- history/co-change: 0.05

Rules:
- no inferred relation on semantic score alone
- minimum of two independent evidence families
- contradiction flags reduce or block confidence
- outputs include confidence band and explanation

## 15.5 Contradiction handling
A candidate pair should be penalized when:
- side effects differ significantly,
- security contexts differ,
- exception semantics differ,
- input/output shapes diverge,
- environment-specific logic conflicts.

## 15.6 Human review
Optional mode:
- medium-confidence homologs can be queued for human confirmation
- confirmed homologs become stronger evidence for future ranking

---

# 16. Contract & Invariant Engine

## 16.1 Purpose
This engine models what code must continue to guarantee after change.

## 16.2 Contract sources
- explicit type signatures
- schemas
- route definitions
- tests
- assertions
- DB constraints
- policy definitions
- error classes
- comments and docs as weak evidence only

## 16.3 Invariant extraction
Invariants may be:
- explicit, from tests/specs
- derived, from repeated assertions and behavior
- manually authored by developers

Examples:
- email must be normalized before persistence
- route returns 403 instead of 404 on policy failure
- tax calculations round to cents using a specific policy

## 16.4 Validation usage
Contracts and invariants are used during:
- planning
- blast radius
- semantic diff
- post-patch validation
- propagation risk assessment

---

# 17. Blast Radius Engine

## 17.1 Purpose
Given a proposed or applied change, estimate who else is affected and how.

## 17.2 Dimensions

### Structural blast radius
Includes:
- callers
- callees
- implementers
- overridden methods
- imports
- type dependencies
- schema bindings

### Behavioral blast radius
Includes:
- shared resources
- same DB tables
- same cache keys
- same event channels
- same auth domain
- same mutation domain

### Contract blast radius
Includes:
- tests
- schema/API clients
- invariants
- serialization assumptions
- error contract dependencies

### Homolog blast radius
Includes:
- duplicate validators
- parallel serializers
- mirrored policy logic
- repeated business rules

### Historical risk blast radius
Includes:
- co-change patterns
- hotspots
- known regression clusters
- flaky or brittle tests

## 17.3 Output structure
Blast radius report should include:
- impacted symbol list
- impact type
- confidence
- severity
- evidence
- recommended validation scope
- propagation recommendations

## 17.4 Example output
Instead of:
> 2 conceptual twins detected

ContextZero returns:

- `Billing.check_email_format`
  - impact type: homolog
  - relation: validator_homolog
  - confidence: 0.95
  - reason: same regex class, same input contract, same normalization path
  - action: recommended propagation

- `Admin.verify_user_email`
  - impact type: homolog
  - relation: auth_policy_peer
  - confidence: 0.81
  - caution: role-based branch differs
  - action: manual review recommended

- `SignupEmailValidationTest`
  - impact type: contract dependency
  - confidence: 0.92
  - action: rerun test

---

# 18. Context Capsule Compiler

## 18.1 Purpose
Provide the consumer with the smallest complete context necessary for high-confidence reasoning.

## 18.2 Capsule contents
A capsule may contain:
- target symbol code
- symbol summary
- relevant signatures/types
- direct callers/callees when needed
- relevant tests
- contract profile
- invariants
- homologs
- recent related changes
- uncertainty notes

## 18.3 Capsule generation policy
The compiler should optimize for:
- sufficiency,
- minimality,
- exactness.

It should not include:
- whole files unless required,
- large unrelated modules,
- semantically “nearby” but unsupported context.

## 18.4 Capsule modes
- `minimal`: target symbol + direct contract/test context
- `standard`: minimal + immediate dependencies + top homologs
- `strict`: standard + deeper blast radius and historical risk context

## 18.5 Token budget behavior
If token budget is tight:
1. preserve target symbol
2. preserve hard constraints
3. preserve highest-confidence dependencies
4. summarize lower-priority related symbols

---

# 19. Transactional Change Engine

## 19.1 Purpose
Treat edits as formal transactions instead of direct file rewrites.

## 19.2 Change lifecycle
1. plan change
2. compile capsule
3. prepare transaction
4. apply patch in sandbox
5. reindex affected graph region
6. compute blast radius
7. validate change
8. propose propagation
9. commit or rollback

## 19.3 Transaction states
- `planned`
- `prepared`
- `patched`
- `reindexed`
- `validated`
- `propagation_pending`
- `committed`
- `rolled_back`
- `failed`

## 19.4 Sandbox execution
Patch application and validation run inside isolated environments:
- container or microVM
- restricted filesystem/network
- resource/time limits

## 19.5 Rollback
Rollback restores:
- source file changes
- affected symbol versions
- derived indexes
- invalid transient reports

---

# 20. Validation Framework

## 20.1 Validation layers
Validation should be progressive.

### Level 1: Parse validation
- syntax correctness
- AST stability

### Level 2: Type/build validation
- type checker
- compiler/build
- dependency resolution

### Level 3: Targeted test validation
- tests directly linked to changed symbols

### Level 4: Impacted test validation
- tests in blast radius

### Level 5: Contract validation
- schema checks
- invariant checks
- API contract checks
- error contract checks

### Level 6: Semantic diff validation
Compares before vs after at the symbol level.

Questions:
- did side effects change?
- did return type effectively change?
- did exception behavior change?
- did auth behavior change?
- did serialization change?
- did persistence behavior expand?

## 20.2 Validation modes
- `quick`: parse + type + direct tests
- `standard`: quick + impacted tests + contract checks
- `strict`: standard + expanded blast radius and semantic diff gating

---

# 21. Uncertainty Model

## 21.1 Why it matters
Precision requires honest uncertainty.
The system must not overstate confidence in dynamic or partially resolved contexts.

## 21.2 Uncertainty sources
- dynamic imports
- runtime code generation
- reflection/metaprogramming
- monkey patching
- incomplete type info
- generated code not indexed
- framework magic
- missing test evidence

## 21.3 Representation
Every major response may include:
- confidence score
- confidence band
- unresolved factors
- blind spot annotations
- recommended next evidence source

Example:
> Confidence 0.71. Route binding partially unresolved due to runtime registration in framework bootstrap.

---

# 22. MCP Tool API Design

## 22.1 Design goals
The MCP interface exposes:
- exact retrieval,
- task planning,
- context compilation,
- change transactions,
- validation,
- propagation,
- homolog review,
- V2 analysis (dispatch, lineage, effects, concept families, temporal risk, runtime evidence),
- operational management (repo registration, ingestion, search, caching).

## 22.2 Discovery tools

### `scg_resolve_symbol`
Input:
- natural language query or symbol query

Output:
- candidate symbols
- confidence
- ambiguity reasons

### `scg_find_concept`
Input:
- concept string
- optional filters

Output:
- ranked symbol list
- relation hints
- evidence summaries

### `scg_get_symbol_details`
Input:
- symbol version ID
- view mode (`code`, `summary`, `behavior`, `contract`, `full`)

Output:
- exact symbol payload

### `scg_get_neighbors`
Input:
- symbol ID
- relation types
- depth

Output:
- local graph neighborhood

### `scg_explain_relation`
Input:
- two symbol IDs

Output:
- relation type
- confidence
- evidence bundle summary

## 22.3 Context tools

### `scg_compile_context_capsule`
Input:
- symbol version ID
- snapshot ID
- mode
- token budget

Output:
- capsule payload
- omission rationale
- uncertainty notes

### `scg_get_invariants`
Input:
- symbol ID

Output:
- invariant list
- strengths
- sources

### `scg_get_tests`
Input:
- symbol ID
- snapshot ID

Output:
- test artifacts
- assertion summaries
- frameworks
- coverage hints

### `scg_semantic_diff`
Input:
- before symbol version ID
- after symbol version ID

Output:
- 9-dimension semantic comparison (signature, behavior, contracts, side effects, dependencies, error handling, performance, security, API surface)

### `scg_contract_diff`
Input:
- before symbol version ID and after symbol version ID, or transaction ID

Output:
- contract delta analysis
- breaking change detection
- migration guidance

## 22.4 Planning tools

### `scg_plan_change`
Input:
- natural language task
- optional scope constraints

Output:
- target candidates
- confidence
- assumptions
- initial blast radius
- recommended capsule mode

### `scg_blast_radius`
Input:
- symbol version IDs
- snapshot ID
- depth

Output:
- multi-dimensional impact report

### `scg_find_homologs`
Input:
- symbol ID
- relation filters
- minimum confidence

Output:
- homolog list with evidence

## 22.5 Editing tools

### `scg_prepare_change`
Input:
- repo ID
- base snapshot ID
- target symbol version IDs
- optional plan ID
- optional created_by

Output:
- transaction ID
- locked target versions
- preconditions

### `scg_apply_patch`
Input:
- transaction ID
- patch set

Output:
- patch status
- affected symbols
- reindex trigger result

### `scg_propagation_proposals`
Input:
- transaction ID
- snapshot ID

Output:
- homolog propagation candidates
- safe/unsafe classification

### `scg_apply_propagation`
Input:
- transaction ID
- target symbol version ID
- patch (file_path, new_content)

Output:
- propagation result
- affected symbols
- reindex status

## 22.6 Validation tools

### `scg_validate_change`
Input:
- transaction ID
- mode

Output:
- validation report

### `scg_semantic_diff`
Input:
- before symbol version ID
- after symbol version ID

Output:
- 9-dimension semantic change summary (signature, behavior, contracts, side effects, dependencies, error handling, performance, security, API surface)

### `scg_contract_diff`
Input:
- before symbol version ID and after symbol version ID, or transaction ID

Output:
- contract delta summary
- breaking change flags
- migration hints

### `scg_commit_change`
Input:
- transaction ID

Output:
- commit status
- final reports

### `scg_rollback_change`
Input:
- transaction ID

Output:
- rollback status

## 22.7 Review tools

### `scg_review_homolog`
Input:
- inferred relation ID
- review state (`confirmed`, `rejected`, `flagged`)
- optional reviewer

Output:
- updated relation state
- review timestamp

## 22.8 V2 Analysis tools

### `scg_get_dispatch_edges`
Input:
- symbol version ID

Output:
- dispatch edges (virtual/dynamic call targets)
- total count

### `scg_get_class_hierarchy`
Input:
- symbol version ID
- snapshot ID

Output:
- method resolution order (MRO)

### `scg_get_symbol_lineage`
Input:
- symbol ID

Output:
- lineage history across snapshots

### `scg_get_effect_signature`
Input:
- symbol version ID

Output:
- effect classification (pure, read-only, write, mixed)
- reads/writes resources
- emits events
- calls external
- mutates state
- requires auth
- throws errors
- confidence

### `scg_diff_effects`
Input:
- before symbol version ID
- after symbol version ID

Output:
- effect delta between versions

### `scg_get_concept_family`
Input:
- symbol version ID

Output:
- concept family membership

### `scg_list_concept_families`
Input:
- snapshot ID

Output:
- all concept families in snapshot
- total count

### `scg_get_temporal_risk`
Input:
- symbol ID
- snapshot ID

Output:
- temporal risk score

### `scg_get_co_change_partners`
Input:
- symbol ID
- repo ID
- optional min_jaccard (default 0.3)

Output:
- co-change partners ranked by Jaccard similarity
- total count

### `scg_ingest_runtime_trace`
Input:
- repo ID
- snapshot ID
- trace_pack (source, timestamp, call_edges, dynamic_routes, observed_types, framework_events)

Output:
- ingestion result

### `scg_get_runtime_evidence`
Input:
- symbol version ID

Output:
- runtime evidence (observed call edges, dynamic routes, type observations)

## 22.9 Operational tools

### `scg_register_repo`
Input:
- repo name
- repo path
- optional visibility (`private`, `internal`, `public`)

Output:
- repo ID
- registration status

### `scg_ingest_repo`
Input:
- repo ID or repo name
- optional languages filter
- optional max files

Output:
- snapshot ID
- ingestion statistics (files parsed, symbols extracted, relations inferred)

### `scg_incremental_index`
Input:
- repo ID
- base snapshot ID
- changed file paths
- optional languages filter

Output:
- new snapshot ID
- incremental update statistics

### `scg_list_repos`
Input:
- optional limit
- optional offset

Output:
- repository list with metadata

### `scg_list_snapshots`
Input:
- repo ID
- optional limit
- optional offset

Output:
- snapshot list with metadata

### `scg_snapshot_stats`
Input:
- snapshot ID

Output:
- symbol counts by kind and language
- relation counts
- coverage metrics

### `scg_batch_embed`
Input:
- snapshot ID

Output:
- embedding generation status
- symbols embedded count

### `scg_persist_homologs`
Input:
- source symbol version ID
- snapshot ID
- optional confidence threshold

Output:
- persisted homolog count
- homolog details

### `scg_read_source`
Input:
- repo ID
- symbol version IDs or file path

Output:
- source code content
- file metadata

### `scg_search_code`
Input:
- repo ID
- pattern (regex)
- optional file pattern

Output:
- matching files and lines

### `scg_codebase_overview`
Input:
- repo ID
- optional snapshot ID

Output:
- language breakdown
- top-level module structure
- key entry points
- architecture summary

### `scg_semantic_search`
Input:
- query (natural language)
- snapshot ID
- optional limit

Output:
- ranked symbol matches by semantic similarity

### `scg_smart_context`
Input:
- task description
- target symbol version IDs
- snapshot ID
- optional token budget
- optional depth

Output:
- compiled context package optimized for the task
- token usage

### `scg_cache_stats`
Input:
- (none)

Output:
- cache hit/miss statistics per cache layer (symbol, profile, capsule, homolog, query)

## 22.10 Admin tools

### `scg_admin_run_retention`
Input:
- (none)

Output:
- retention policy results (snapshots expired, capped, stale transactions cleaned, orphans removed)
- duration and error summary

### `scg_admin_retention_stats`
Input:
- (none)

Output:
- total/expired snapshots, stale transaction count, oldest snapshot age, last cleanup timestamp

### `scg_admin_cleanup_stale`
Input:
- (none)

Output:
- cleaned and remaining stale transaction counts

### `scg_admin_db_stats`
Input:
- (none)

Output:
- table sizes, row counts, least-used indexes, database size, connection pool state

### `scg_admin_system_info`
Input:
- (none)

Output:
- server uptime, memory usage, entity counts, connection health, cache statistics

---

# 23. Example End-to-End Workflow

## Task
“Fix inconsistent email normalization in signup and related flows.”

## Step 1: Planning
The consumer calls `scg_plan_change`.

SCG returns:
- primary target: `Auth.validate_email`
- confidence: high
- related symbols:
  - `SignupController.create_user`
  - `Billing.check_email_format`
  - `Admin.verify_user_email`
- recommended mode: standard capsule

## Step 2: Context
The consumer calls `scg_compile_context_capsule`.

Capsule includes:
- target symbol code
- input/output contract
- related tests
- invariant: normalized email must be lowercase and trimmed
- homolog: `Billing.check_email_format`
- uncertainty: admin verifier has role branch

## Step 3: Patch
The consumer proposes patch to target symbol.

## Step 4: Apply and reindex
SCG creates transaction, applies patch in sandbox, reindexes changed symbols.

## Step 5: Blast radius
SCG detects:
- contract dependency in signup tests
- homolog propagation opportunity in billing
- cautious homolog in admin flow

## Step 6: Validation
SCG runs:
- parse
- typecheck
- signup tests
- billing validation tests
- invariant checks

## Step 7: Propagation
SCG proposes:
- safe propagation to `Billing.check_email_format`
- manual review for `Admin.verify_user_email`

## Step 8: Commit
After approval and validation, SCG commits.

---

# 24. Security and Isolation

## 24.1 Code access
Access to repositories must be authenticated and authorized.

## 24.2 Validation sandbox
All builds/tests execute in sandboxed subprocesses:
- process group isolation (`setsid`) with SIGTERM → SIGKILL escalation
- `ulimit` resource constraints (CPU time, memory, file descriptors)
- environment sanitization — credentials, secrets, and sensitive variables stripped
- `unshare` namespace isolation when available on Linux
- output truncation to prevent memory exhaustion

## 24.3 Secret handling
SCG must not expose:
- runtime secrets,
- env vars,
- credentials,
- production tokens,
inside capsules unless explicitly authorized.

## 24.4 Multi-tenant considerations (not implemented)
Multi-tenancy is not currently implemented. ContextZero operates as a single-tenant system. If multi-tenant support is needed in the future, consider:
- tenant isolation on storage (row-level or schema-level)
- per-tenant encryption keys
- namespace isolation for cache layers

---

# 25. Observability

## 25.1 Metrics
Track:
- indexing latency
- symbol extraction failures
- relation inference counts
- homolog precision/acceptance rates
- capsule size distributions
- validation success/failure rates
- rollback rates
- task resolution confidence distributions

## 25.2 Logs
Structured logs for:
- parser errors
- relation inference decisions
- blast radius computation
- validation outputs
- tool call traces

## 25.3 Tracing
Distributed tracing should cover:
- plan request
- retrieval
- capsule compilation
- patch transaction
- validation execution

---

# 26. Performance and Scaling

## 26.1 Incremental indexing
Only reanalyze:
- changed files,
- affected symbols,
- neighboring graph regions,
- stale inferred relations,
- impacted capsules.

## 26.2 Candidate-first inference
Use approximate nearest neighbor search only to shortlist candidates, then exact reranking.

## 26.3 Capsule caching
Cache capsules by:
- symbol version,
- task class,
- token budget mode.

## 26.4 Parallelization
Parallelize:
- file parsing
- behavior extraction
- semantic profiling
- candidate generation
- independent validation suites

## 26.5 Large repo strategy
For monorepos:
- package-level indexing partitions
- cross-package relation stitching
- demand-based deeper analysis

---

# 27. Failure Modes and Mitigations

## 27.1 Parse failure
Mitigation:
- preserve previous valid snapshot
- mark partial index
- report uncertainty

## 27.2 Wrong target resolution
Mitigation:
- confidence thresholds
- ambiguity reporting
- plan tool returns alternatives

## 27.3 False homologs
Mitigation:
- require multi-evidence support
- contradiction penalties
- optional human review for medium confidence

## 27.4 Missed homologs
Mitigation:
- continuous retraining/tuning of candidate generation
- use history and test evidence
- support manual relation annotation

## 27.5 Over-large capsules
Mitigation:
- capsule budget optimizer
- summarization of lower-priority dependencies
- strict inclusion policy

## 27.6 Validation blind spots
Mitigation:
- uncertainty reporting (12-source model)
- runtime trace ingestion (implemented via `scg_ingest_runtime_trace`)
- framework-specific behavioral patterns (60+ patterns across 8 languages)

---

# 28. Implementation Status

All five phases are fully implemented and operational:

## Phase 1: Structural truth foundation — COMPLETE
- Repository ingestion with 13-language adapter support
- TypeScript Compiler API + tree-sitter symbol extraction
- Structural graph engine with two-pass resolution
- 56 MCP tools + 55 HTTP routes
- Context capsule compilation with 5-level degradation

## Phase 2: Contracts and tests — COMPLETE
- Test artifact linkage with assertion summaries
- Contract extraction (input/output/error/security/serialization)
- Deep contract synthesis (~3,000 lines, largest engine)
- Invariant mining from 6 sources
- 5-dimensional blast radius analysis

## Phase 3: Homolog engine — COMPLETE
- Native TF-IDF + MinHash + LSH (no external dependencies)
- 5 candidate generation buckets
- 7-dimensional weighted scoring with contradiction detection
- `explain_relation` and `find_concept` tools
- Concept family clustering with 10 family types

## Phase 4: Transactional editing — COMPLETE
- 9-state lifecycle with plan/prepare/apply/validate/commit/rollback
- Sandboxed subprocess execution
- Semantic diff (9 dimensions) and contract diff
- Homolog propagation proposals and execution

## Phase 5: Runtime enhancement — COMPLETE
- Runtime trace ingestion with payload truncation
- Dispatch resolver with C3 linearization and 9 receiver patterns
- Temporal engine with git history mining and risk scoring
- Symbol lineage with cross-snapshot identity tracking
- 12-source uncertainty model

## Phase 6: Production lifecycle — COMPLETE
- Data retention service with snapshot expiry, per-repo caps, stale transaction cleanup, orphan data removal
- Advisory-locked retention policy execution with audit trail (`cleanup_log` table)
- Configurable retention via environment variables (age, cap, timeout, interval)
- Periodic automated retention scheduling with graceful shutdown integration
- 5 admin MCP tools and 5 admin HTTP endpoints (retention, cleanup, db stats, system info)
- Enhanced health checks with pool pressure, stale transactions, base path accessibility
- BRIN indexes on temporal tables for production-scale performance
- Startup diagnostics with configuration summary logging

---

# 29. Success Metrics

## 29.1 Precision metrics
- correct target symbol rate
- irrelevant context reduction
- homolog precision at top-k
- contract violation catch rate
- regression reduction after AI edits

## 29.2 Efficiency metrics
- average capsule token size
- average plan latency
- validation latency by mode
- reindex time per changed file

## 29.3 Outcome metrics
- successful AI edit rate
- rollback rate
- number of multi-site bug fixes correctly propagated
- reduction in post-edit breakage

---

# 30. Open Questions

1. How much runtime trace support is needed for Python dynamic frameworks? (Runtime evidence engine is implemented but framework-specific Python dynamic resolution is ongoing)
2. Should medium-confidence homologs require explicit developer confirmation by policy? (Implemented: `scg_review_homolog` tool with reviewer tracking — policy is caller's choice)
3. How should developer-authored invariants be represented and versioned? (Implemented: `invariants` table with `source_type = 'manual'`, scoped at global/module/symbol level)
4. What is the right fallback behavior when tests are absent? (Implemented: uncertainty tracker flags `missing_test_evidence`, capsule compiler includes uncertainty notes)
5. Should propagation patches be generated by the consumer or by template transforms? (Implemented: consumer generates patches via `scg_apply_propagation`, system validates and applies)

---

# 31. Final Technical Position

ContextZero is:

> **A versioned, evidence-carrying, contract-aware code cognition and change orchestration system that enables AI coding agents to operate on exact symbols, infer hidden homologous logic across a repository, compile minimal sufficient context, reason about blast radius natively, and execute validated transactional edits.**

**52 production source files** | **37,800+ lines of TypeScript** | **13 analysis engines** | **61 MCP tools** | **60 HTTP routes** | **13 supported languages** | **29 database tables** | **15 migrations**

ContextZero is not:
- a passive database,
- generic search,
- chunk retrieval,
- ordinary patchwork.

ContextZero is:
- exact,
- native,
- verifiable,
- production-grade,
- fully implemented.
