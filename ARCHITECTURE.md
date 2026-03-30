# ContextZero — Architecture

## 1. System Overview

ContextZero is a **code cognition engine** — it indexes codebases into a structured graph and serves precise, token-budgeted context to AI agents via the Model Context Protocol (MCP).

**52 production source files** | **37,800+ lines of TypeScript** | **13 analysis engines** | **61 MCP tools** | **60 HTTP routes** | **13 supported languages**

## 2. Engine Boundaries & Responsibility Pattern

The service layer is implemented in **TypeScript (Node.js 22+)** with three language adapter tiers:

- **TypeScript/JavaScript** — TypeScript Compiler API (`ts.createProgram`, `ts.TypeChecker`) for full type-aware AST parsing
- **Python** — LibCST with `PositionProvider` metadata, run as a subprocess via `execFileSync` with array args (command injection safe)
- **C++ / Go / Rust / Java / C# / Ruby / Kotlin / Swift / PHP / Bash** — tree-sitter universal adapter for native CST parsing

All adapters produce the same normalized output (`AdapterExtractionResult`), ensuring uniform downstream processing regardless of source language.

## 3. Core Subsystems

### 3.1 Database Layer (`db-driver` — 6 files)
- **Connection pool** — PostgreSQL with transaction support at 3 isolation levels (READ COMMITTED, REPEATABLE READ, SERIALIZABLE). Max 20 connections, 30s idle timeout, 5s connection timeout. Queue depth monitoring rejects at 2x pool size.
- **Circuit breaker** — Closed/open/half-open state machine with transient PostgreSQL error code detection, exponential backoff retry, configurable failure threshold and recovery timeout.
- **Batch loader** — Chunked parameterized IN queries (CHUNK_SIZE=5000, MAX_SNAPSHOT_LOAD=50,000). Table/column allowlist prevents SQL injection in dynamic query construction. Chunk-level error resilience with partial result recovery.
- **Result validators** — Runtime type validation at the DB boundary via `validateSymbolVersionRow`, `validateBehavioralProfile`, `validateContractProfile`, `validateStructuralRelation`, and generic `validateRows` batch validator.
- **Migration runner** — Advisory-locked, checksummed, per-migration transactions with statement/lock timeout enforcement. Detects tampered migrations in production.
- **Connection config** — SSL mode validation (disable/allow/prefer/require), insecure password rejection in production, API key entropy validation.

### 3.2 Ingestion Pipeline (`ingestor`)
- Full and incremental repository scanning with differential parsing.
- Dispatches to language-specific adapters based on file extension (20+ extensions mapped to 13 languages).
- Populates test artifacts by linking test files to the symbols they reference.
- Orchestrates all 13 analysis engines post-extraction in a single pipeline.
- V2 engines (dispatch, lineage, effects, deep contracts, concept families, temporal) are non-fatal — wrapped in try/catch to prevent partial failures from aborting ingestion.
- Cache invalidation after successful ingestion.
- Advisory lock per (repo, snapshot) prevents concurrent ingestion conflicts.

### 3.3 Language Adapters (`adapters/ts`, `adapters/universal`)
- **TypeScript Adapter** — Uses `ts.createProgram` and `ts.TypeChecker` for project-level type resolution. Extracts symbols, structural relations, 30+ behavioral side-effect patterns, and contract hints (parameter types, return types, thrown exceptions, decorators).
- **Universal Adapter (tree-sitter)** — Production-grade multi-language parser supporting 11 additional languages beyond TypeScript and Python. Language-specific walkers for symbol/relation/contract extraction. SHA-256 hashing for AST fingerprints. Falls back gracefully when native tree-sitter bindings are unavailable.

### 3.4 AST Normalization Engine (`adapters/ts/ast-normalizer`)
- Produces rename-invariant, whitespace-invariant, comment-invariant normalized AST hashes.
- Alpha-renames function names, local variables, and parameters for structural comparison.
- String literal protection during normalization to prevent false positives.
- Regex fallback for raw code when TypeScript AST is unavailable.

### 3.5 Semantic Engine (`semantic-engine` — 3 files)
- **Native multi-view TF-IDF** embedding engine with zero external dependencies (no pgvector, no Qdrant).
- **5-view tokenization**: name, body, signature, behavior, contract. Code-aware tokenizer with compound name splitting, suffix stemming, and noise word removal (MAX_TOKENIZE_LENGTH=100,000).
- **MinHash signatures** (128 permutations) with BigInt arithmetic to prevent 2^53 overflow. Empty-set sentinel detection.
- **LSH banding** (16 bands x 8 rows) for sub-linear candidate retrieval.
- **Cosine similarity** on L2-normalized sparse TF-IDF vectors for precise scoring.
- **FNV-1a hashing** for efficient hash computation.

### 3.6 Analysis Engines (`analysis-engine`) — 13 engines

| Engine | File | Lines | Responsibility |
|--------|------|-------|---------------|
| **Structural Graph** | `index.ts` | ~180 | Two-pass relation resolution (in-memory map + chunked DB fallback). Batch inserts with conflict handling. Source/target failure tracking. |
| **Behavioral** | `behavioral.ts` | ~610 | 4-tier purity classification (pure / read_only / read_write / side_effecting). Kahn's topological sort for O(V+E) transitive propagation. Cycle recovery via BFS clustering. |
| **Contract** | `contracts.ts` | ~380 | Input/output/error/security contract extraction. Invariant mining from 6 sources (tests, schemas, behavioral profiles, contract profiles, exception profiles, purity). |
| **Deep Contract Synthesizer** | `deep-contracts.ts` | ~3,000 | Code-body-level contract mining — boundary checks, null safety, guard clauses, return shape analysis, decorator extraction. Ingestion-only engine (no query-time MCP tool). Largest engine by line count. |
| **Blast Radius** | `blast-radius.ts` | ~400 | 5-dimensional impact analysis (structural, behavioral, contract, homolog, historical), computed in parallel via `Promise.all`. Frontier width cap at 500 with logging. MAX_INTERNAL_DEPTH=5. |
| **Capsule Compiler** | `capsule-compiler.ts` | ~1,180 | Token-budgeted minimal context in 3 modes (minimal/standard/strict). 5-level degradation ladder: full_source → signature_only → contract_summary → effect_summary → name_only. Compilation caching. |
| **Effect Engine** | `effect-engine.ts` | ~1,450 | 9 typed effect kinds (reads, writes, opens, throws, calls_external, logs, emits, normalizes, acquires_lock). 5-tier classification. 60+ framework patterns across 8 languages. Kahn's topological sort for transitive propagation. |
| **Dispatch Resolver** | `dispatch-resolver.ts` | ~1,780 | C3 linearization MRO. 9 receiver type inference patterns (constructor assignment, TS/Python field annotation, DI constructor, dataclass, Rust struct, Java/C#/Go fields, factory return). Whole-snapshot batch resolution. |
| **Concept Family** | `concept-families.ts` | ~1,480 | Connected components clustering with Kernighan-Lin style modularity bisection. 10 family types. Exemplar selection, outlier/contradiction detection, family fingerprinting. |
| **Temporal** | `temporal-engine.ts` | ~980 | Git history mining via `execFileAsync('git', ...)`. Co-change pair computation (Jaccard similarity). Risk scoring (frequency, bug-fix correlation, churn). |
| **Symbol Lineage** | `symbol-lineage.ts` | ~1,110 | Deterministic identity seeds (SHA-256). 5-signal fuzzy matching (normalized AST, body hash, neighborhood, signature, Levenshtein name distance). Birth/death tracking. |
| **Runtime Evidence** | `runtime-evidence.ts` | ~1,480 | Runtime trace ingestion with payload truncation. Observed edge persistence. Evidence retrieval per symbol. |
| **Uncertainty Tracker** | `uncertainty.ts` | ~240 | 12-source uncertainty model. Per-symbol and per-snapshot confidence scoring. Evidence recommendations. |

### 3.7 Homolog Inference Engine (`homolog-engine`)
- **7-dimension weighted scoring** (sum=1.0): semantic intent (0.20), normalized logic (0.20), signature/type (0.15), behavioral overlap (0.15), contract overlap (0.15), test overlap (0.10), history co-change (0.05).
- **5 candidate generation buckets**: body hash exact match, AST hash exact match, name similarity (pg_trgm), behavioral profile overlap, contract profile overlap.
- Batch-loads all profiles in 2 bulk queries (no N+1).
- Contradiction detection: side_effects_differ, exception_semantics_differ, security_context_differs, io_shape_diverges.
- Minimum 2 evidence families required. No inference on semantic score alone.
- Confidence threshold: 0.70.

### 3.8 Transactional Change Engine (`transactional-editor` — 2 files)
- **9-state lifecycle**: planned → prepared → patched → reindexed → validated → propagation_pending → committed / rolled_back / failed.
- **6-level progressive validation**: syntax → type check → contract delta → behavioral delta → invariant check → test execution.
- **3 validation modes**: quick (parse + type + direct tests), standard (quick + impacted tests + contract checks), strict (standard + expanded blast radius + semantic diff gating).
- Persistent file backups in PostgreSQL with advisory locks for concurrent access. 5MB file size limit per backup.
- **Sandboxed subprocess execution** (`sandbox.ts`): environment sanitization, ulimit resource constraints, process group isolation, SIGTERM → SIGKILL escalation, output truncation. `unshare` namespace detection.
- Stale transaction cleanup and transaction recovery.

### 3.9 API Layer
- **REST API (`mcp-interface`)** — Express 5 HTTP server with **60 routes** (7 GET + 53 POST). Fail-closed API key auth, per-route rate limiting, per-route body size limits (ingestion: 10MB, patches: 5MB, queries: 100KB, default: 1MB), input validation on every route via `validateBody()`, Prometheus metrics, correlation IDs (X-Request-ID), HSTS enforcement, and sanitized error responses via `UserFacingError`. Includes admin endpoints for retention, cleanup, database stats, and system info.
- **MCP Stdio Bridge (`mcp-bridge`)** — Native Model Context Protocol server over stdio transport. **61 tools** registered with Zod schema validation. `safeTool` wrapper for structured error handling with allowlisted error prefixes. All logging to stderr to preserve the JSON-RPC stream.
- **Native Workspace Tools** — 3 DB-free tools (`scg_native_codebase_overview`, `scg_native_symbol_search`, `scg_native_search_code`) for direct filesystem analysis via `workspace-native.ts`. Available only through MCP bridge (no HTTP routes).

### 3.10 Caching Layer (`cache`)
- In-process LRU cache with TTL (no Redis dependency).
- 5 cache layers: symbol, profile, capsule, homolog, query.
- Periodic 60-second cleanup of expired entries.
- Prefix-based invalidation on incremental re-indexing.
- Cache statistics exposed via `scg_cache_stats` tool.

### 3.11 Service Layer (`services` — 9 files)
Transport-agnostic business logic shared between REST API and MCP bridge:

| Service File | Exports |
|-------------|---------|
| `symbol-service.ts` | `resolveSymbol`, `getSymbolDetails` |
| `overview-service.ts` | `getCodebaseOverview` |
| `context-service.ts` | `compileSmartContext` |
| `search-service.ts` | `searchCode` |
| `repo-service.ts` | `listRepos`, `listSnapshots` |
| `graph-service.ts` | `getNeighbors`, `explainRelation`, `getTests`, `findConcept`, `reviewHomolog` |
| `diff-service.ts` | `computeSemanticDiff`, `computeContractDiff` |
| `planning-service.ts` | `planChange`, `prepareChange`, `applyPropagation` |
| `retention-service.ts` | `runRetentionPolicy`, `getRetentionStats`, `listStaleTransactions`, `cleanupExpiredSnapshots`, `enforceSnapshotCap`, `cleanupStaleTransactions`, `cleanupOrphanedData` |

### 3.12 Observability (`metrics`, `logger`)
- **Structured JSON logging** to stderr with child loggers, timer tracking, circular reference protection.
- **Prometheus metrics**: counters (`scg_requests_total`, `scg_errors_total`, `scg_auth_failures_total`), histograms (`scg_request_duration_seconds`, `scg_query_duration_seconds`), gauges (`scg_db_pool_total`, `scg_db_pool_idle`, `scg_db_pool_waiting`). Max 10K metric series.
- **Health endpoints**: `GET /health` (liveness), `GET /ready` (readiness), `GET /metrics` (Prometheus text format).

### 3.13 Security (`path-security`, `middleware/auth`, `middleware/validation`, `middleware/rate-limiter`)
- **Path security** — 5-layer defense: null byte rejection, URL-encoded traversal prevention, backslash rejection on POSIX, symlink escape detection via `fs.realpathSync()`, boundary enforcement to registered base paths.
- **Authentication** — Fail-closed API key auth via `crypto.timingSafeEqual()`. Per-IP brute-force lockout with exponential backoff (up to 60-min lockout). 32-char minimum key in production. SIGHUP hot-reload. Max 10K tracked IPs.
- **Input validation** — `validateBody()` middleware on every route. UUID strict regex, bounded integers, string max length (2000 chars), patch size limits (5MB/patch, 100 patches/request), path traversal checks. `optionalBoundedInt` / `requireBoundedInt` distinction for optional vs required numeric fields.
- **Rate limiting** — O(1) token bucket per client IP with per-route configuration (ingestion: 5/5min, expensive: 20-30/min, default: 60/min). Retry-After header. Integer arithmetic to prevent floating-point drift.
- **Error sanitization** — `UserFacingError` class with static factories (notFound, forbidden, badRequest). No stack traces, internal paths, or SQL text in responses.

## 4. Database Schema

- **15 migrations** (versioned, SHA-256 checksummed, advisory-locked)
- **29 active application tables** covering symbols, relations, behavioral profiles, contract profiles, invariants, effect signatures, dispatch edges, class hierarchy, concept families, temporal co-changes, runtime traces, semantic vectors, LSH bands, capsule compilations, change transactions, evidence bundles, and cleanup audit log
- **Performance indexes** including compound indexes, GIN indexes on array columns, trigram indexes for fuzzy search (pg_trgm), BRIN indexes on temporal tables, and targeted indexes on FK columns
- **Full FK integrity** with ON DELETE CASCADE
- **CHECK constraints** on enum columns and score bounds [0.0, 1.0]
- **UNIQUE constraints** on deduplication-critical tables (evidence bundles, invariants)
- **Retention support** with `retained_until` column on snapshots and `cleanup_log` audit table

## 5. Storage Architecture

| Concern | Implementation | Notes |
|---------|---------------|-------|
| Relational store | PostgreSQL 16 | Primary data store for all entities |
| Vector similarity | Native TF-IDF + MinHash + LSH | Zero external dependencies; pgvector not required |
| Lexical search | Native regex + pg_trgm | No OpenSearch/Tantivy/Lucene needed |
| Caching | In-process LRU with TTL | No Redis dependency; sufficient for single-instance deployment |
| Processing | Synchronous pipeline | No event bus (NATS/Kafka); ingestion is request-driven via API/MCP |

## 6. 61 MCP Tools — Complete Registry

| Category | Tools | Count |
|----------|-------|-------|
| **Core** | `scg_health_check`, `scg_register_repo`, `scg_list_repos`, `scg_ingest_repo`, `scg_incremental_index`, `scg_codebase_overview`, `scg_snapshot_stats`, `scg_cache_stats` | 8 |
| **Symbol Intelligence** | `scg_resolve_symbol`, `scg_get_symbol_details`, `scg_get_symbol_relations`, `scg_read_source`, `scg_search_code`, `scg_semantic_search`, `scg_get_tests`, `scg_get_neighbors` | 8 |
| **Behavioral & Contract** | `scg_get_behavioral_profile`, `scg_get_contract_profile`, `scg_get_invariants`, `scg_get_uncertainty`, `scg_get_effect_signature`, `scg_diff_effects`, `scg_explain_relation`, `scg_find_concept` | 8 |
| **Impact Analysis** | `scg_blast_radius`, `scg_compile_context_capsule`, `scg_smart_context`, `scg_find_homologs`, `scg_persist_homologs`, `scg_propagation_proposals`, `scg_semantic_diff`, `scg_contract_diff` | 8 |
| **Change Planning** | `scg_plan_change`, `scg_prepare_change`, `scg_apply_propagation`, `scg_review_homolog` | 4 |
| **Code Graph** | `scg_get_dispatch_edges`, `scg_get_class_hierarchy`, `scg_get_symbol_lineage`, `scg_get_co_change_partners`, `scg_get_temporal_risk`, `scg_get_runtime_evidence`, `scg_get_concept_family`, `scg_list_concept_families` | 8 |
| **Transactional Editing** | `scg_create_change_transaction`, `scg_get_transaction`, `scg_apply_patch`, `scg_validate_change`, `scg_commit_change`, `scg_rollback_change` | 6 |
| **Data Management** | `scg_list_snapshots`, `scg_batch_embed`, `scg_ingest_runtime_trace` | 3 |
| **Native Workspace** | `scg_native_codebase_overview`, `scg_native_symbol_search`, `scg_native_search_code` | 3 |
| **Admin** | `scg_admin_run_retention`, `scg_admin_retention_stats`, `scg_admin_cleanup_stale`, `scg_admin_db_stats`, `scg_admin_system_info` | 5 |

## 7. Deployment

- **Docker**: Multi-stage Alpine build with non-root user (`scg`), Python 3 + curl, health check (30s interval, 5s timeout, 3 retries).
- **Docker Compose**: PostgreSQL 16-Alpine with `pg_isready` health check, service dependency with health condition, volume for persistence.
- **Graceful Shutdown**: SIGTERM/SIGINT handlers with 10-second timeout, cache cleanup, rate limiter cleanup, auth cleanup, DB pool closure, uncaught exception handler with 3-second emergency exit.
- **Health Endpoints**: `GET /health` (k8s liveness), `GET /ready` (k8s readiness with DB connectivity check), `GET /metrics` (Prometheus scrape target).
- **CI/CD**: GitHub Actions — TypeCheck → Lint → Tests (PostgreSQL 16 container) → Build, coverage artifact upload.

## 8. Language Support

| Tier | Languages | Parser | Behavioral Patterns |
|------|-----------|--------|-------------------|
| Full AST | TypeScript, JavaScript | TypeScript Compiler API | 30+ patterns |
| Full CST | Python | LibCST (subprocess) | 60+ patterns |
| Tree-sitter | C++, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, Bash | tree-sitter native bindings | Framework-aware per language |
