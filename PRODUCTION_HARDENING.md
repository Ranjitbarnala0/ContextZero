# ContextZero — Production Hardening

## Scope

This document specifies the security controls, schema design, resilience architecture, and operational safeguards that make ContextZero production-grade. The system exposes **61 MCP tools** and **60 HTTP routes** (7 GET + 53 POST), backed by **15 migrations** managing **29 active application tables**.

---

## 1. Security Controls

### 1.1 Path Security (`path-security.ts`)
All file operations go through a centralized 5-layer path security module:
1. **Null byte rejection** — prevents C-level string truncation attacks
2. **URL-encoded character rejection** (`%2e`, `%2f`, `%5c`) — blocks encoded traversal
3. **Backslash rejection** on POSIX systems — normalizes to forward slash only
4. **Symlink escape detection** via `fs.realpathSync()` — resolves symlinks and verifies the real path stays within boundaries
5. **Boundary enforcement** — all resolved paths validated to stay within registered repository base paths via `SCG_ALLOWED_BASE_PATHS`

Ancestor resolution for missing paths — when a file doesn't yet exist, walks up the directory tree to find the nearest existing ancestor and validates that.

### 1.2 Authentication (`middleware/auth.ts`)
- **Fail-closed design**: all requests rejected if no API keys configured
- Bearer token or X-API-Key header support
- **Constant-time comparison** via `crypto.timingSafeEqual()` to prevent timing attacks
- **Client fingerprinting**: SHA-256 of full key + User-Agent for rate limiting
- **Per-IP brute-force lockout** with exponential backoff (up to 60-minute lockout)
- Maximum 10K tracked IPs with stale failure cleanup
- Minimum 32-character key length requirement in production
- **Hot-reload** via SIGHUP signal — keys reloaded without restart
- Key entropy validation at startup

### 1.3 Input Validation (`middleware/validation.ts`)
Every HTTP route uses `validateBody()` middleware — zero ad-hoc validation:
- **UUID strict regex** on all symbol/snapshot/repo/transaction identifiers
- **Bounded integers**: `optionalBoundedInt` for optional fields with defaults, `requireBoundedInt` for mandatory fields
- **String max length**: 2000 characters default, 4096 for filesystem paths
- **Patch validation**: 5MB per patch content, 100 patches per request, path traversal prevention (null bytes, URL encoding, backslashes, `..` detection, absolute path rejection)
- **Safe path arrays**: combined string array + path traversal validation for incremental indexing
- **Per-route body size limits**: ingestion 10MB, patches 5MB, queries 100KB, default 1MB
- **Enum validation**: `optionalEnum` / `requireEnum` against allowed value sets
- **Confidence bounds**: [0.0, 1.0] validation for confidence thresholds

### 1.4 SQL Injection Prevention
- **100% parameterized queries** throughout the entire codebase — zero string concatenation in any SQL statement
- Dynamic placeholder generation uses index-based `$N` parameters
- Batch loader uses an **explicit column allowlist** (`ALLOWED_QUERIES`) for dynamic table/column names — disallowed combinations throw immediately
- All table names in batch queries are compile-time constants, never user input

### 1.5 Sandbox Execution (`transactional-editor/sandbox.ts`)
- Child processes run with **ulimit resource constraints** (CPU time, memory, file descriptors)
- **Process group isolation** (`setsid`) for clean cleanup
- **SIGTERM → SIGKILL escalation** with configurable timeout
- **Environment sanitization**: `buildSanitizedEnv()` constructs a minimal environment — credentials, secrets, and sensitive variables never passed to sandboxed processes
- **Output truncation** to prevent memory exhaustion
- **`unshare` namespace detection** — uses Linux namespace isolation when available

### 1.6 Tool-Level Security
- `scg_review_homolog` — reviewer tracking for audit trail
- `scg_plan_change` / `scg_prepare_change` — UUID validation and bounded inputs
- `scg_apply_propagation` — 5MB patch size limit with path traversal checks
- All MCP tools wrapped in `safeTool()` — error prefixes allowlisted for safe client exposure

### 1.7 Error Sanitization
- `UserFacingError` class with static factories (`notFound`, `forbidden`, `badRequest`)
- No stack traces, internal file paths, or SQL query text in error responses
- Correlation IDs in all error responses for debugging without information leakage
- Express `x-powered-by` header disabled

### 1.8 Transport Security
- **HSTS enforcement** on all HTTP responses
- **CORS** with configurable origins
- **X-Request-ID** propagation — accepts incoming header or generates UUID, length-capped at 128 characters

---

## 2. Database Schema & Integrity

### 2.1 Schema Design
- **29 active application tables** (30 created, 1 dropped) with full FK integrity and ON DELETE CASCADE
- **15 migrations** — versioned, SHA-256 checksummed, advisory-locked to prevent concurrent application
- Production mode prevents application of modified migrations (checksum mismatch = abort)
- Statement and lock timeouts configurable for migration safety
- Dedicated connection for advisory lock lifecycle management

### 2.2 Core Tables (10)
| Table | Purpose |
|-------|---------|
| `repositories` | Registered codebases with base paths and language sets |
| `snapshots` | Point-in-time indexes with commit SHA, branch, and parent reference |
| `files` | Indexed files with content hashes, language detection, parse status |
| `symbols` | Canonical symbol identities (stable across snapshots) with lineage reference |
| `symbol_versions` | Per-snapshot symbol state — source code, signatures, AST/body hashes, normalized AST hash |
| `structural_relations` | Call graph edges with provenance tracking |
| `behavioral_profiles` | Purity class, resource touches, exception/state/transaction profiles |
| `contract_profiles` | Input/output/error/security/serialization contracts |
| `invariants` | Derived code invariants with scope levels and strength scores |
| `test_artifacts` | Test-to-symbol linkage with assertion summaries |

### 2.3 V2 Tables (18)
- `dispatch_edges` — Resolved virtual method call targets with receiver type inference
- `class_hierarchy` — C3 linearization MRO chains
- `effect_signatures` — Typed effect entries (reads, writes, throws, acquires_lock, etc.)
- `concept_families` / `concept_family_members` — Auto-grouped symbol families with exemplar/outlier/contradiction flags
- `temporal_co_changes` / `temporal_risk_scores` — Git-derived co-change and risk intelligence
- `symbol_lineage` — Cross-snapshot identity tracking with rename confidence
- `runtime_traces` / `runtime_observed_edges` — Runtime evidence integration
- `capsule_compilations` — Compilation metadata
- `evidence_bundles` — Homolog evidence with 6-score UNIQUE constraint
- `inferred_relations` — Homolog relations with evidence bundle references
- `semantic_vectors` / `idf_corpus` / `lsh_bands` — Embedding storage and LSH index
- `change_transactions` / `transaction_file_backups` — Transactional editing state

### 2.4 Constraints & Validation
- **CHECK constraints** on all enum columns (purity_class, index_status, state, relation_type, etc.) — values match TypeScript type definitions exactly
- **Score bounds** [0.0, 1.0] on all confidence, similarity, and risk score columns
- **Mutual exclusivity** constraint on concept family member roles (exemplar/outlier/contradicting)
- **Line range validation** on symbol versions (start_line >= 0, end_line >= start_line)
- **UNIQUE constraints** on evidence bundles (6-score deduplication), invariants (expression deduplication)

### 2.5 Performance Indexes
- Compound indexes on `(snapshot_id, symbol_version_id)` for common join patterns
- GIN indexes on array columns (`related_symbols`, `uncertainty_flags`)
- Trigram indexes for fuzzy symbol search (`pg_trgm` extension)
- **BRIN indexes** on temporal tables (`temporal_co_changes`, `temporal_risk_scores`, `runtime_observed_edges`, `runtime_traces`) — efficient for append-only time-ordered data
- Per-engine indexes on `effect_signatures`, `inferred_relations`, `invariants`
- FK indexes on `change_transactions.base_snapshot_id`, `invariants.repo_id`, `inferred_relations.evidence_bundle_id`
- Composite index on `capsule_compilations(symbol_version_id, snapshot_id)` for cache lookups
- Partial index on `symbol_lineage(repo_id, canonical_name) WHERE is_alive = true` for active lineage queries
- Retention indexes on `snapshots(retained_until)`, `snapshots(repo_id, created_at)`, and `change_transactions(state, updated_at)`
- Duplicate indexes removed in migration 013 (3 pairs)

### 2.6 Retention & Lifecycle (`cleanup_log`)
- **Cleanup audit log** tracks every retention operation (snapshot expiry, stale transaction cleanup, orphan removal, cap enforcement)
- `retained_until` column on snapshots for policy-based expiry
- Partial index on non-NULL `retained_until` for efficient expiry scans

---

## 3. Resilience

### 3.1 Circuit Breaker (`db-driver`)
- **State machine**: closed → open → half-open
- **Transient error detection** with specific PostgreSQL error codes (connection errors, serialization failures, deadlocks)
- Configurable failure threshold and recovery timeout
- **Exponential backoff retry** for transient failures
- Automatic transition: half-open → closed on success, half-open → open on failure

### 3.2 Connection Pool
- Configurable max connections (default 20, env: `DB_POOL_MAX`)
- Idle timeout: 30 seconds
- Connection timeout: 5 seconds
- **Queue depth monitoring**: rejects queries when pending queue exceeds 2x pool size — prevents cascading timeouts
- Slow query detection and logging
- Rollback failure handling — logs but doesn't propagate to prevent masking the original error

### 3.3 Advisory Locks
- **Migration locking** — prevents concurrent schema changes via `pg_advisory_lock`
- **Incremental ingestion locking** per (repo, snapshot) — prevents data corruption from concurrent indexing
- **Transaction advisory locks** for concurrent editing safety
- Dedicated DB connection for advisory lock lifecycle (survives pool pressure)

### 3.4 Batch Loader Resilience
- **Chunk-level error recovery** — if one chunk query fails, remaining chunks continue with partial results
- Failed chunks logged with context (table, column, chunk index, size, error message)
- **Row-level validation** via `validateBehavioralProfile`, `validateContractProfile`, `validateSymbolVersionRow` — malformed rows skipped with warnings rather than crashing
- Table/column allowlist prevents SQL injection in dynamic queries

### 3.5 Graceful Shutdown
- **SIGTERM/SIGINT** signal handlers for orchestrated shutdown
- **10-second graceful timeout** with force exit fallback
- Cleanup order: cache → rate limiter → auth → DB pool
- **Uncaught exception handler** with 3-second emergency exit — logs the error, then terminates
- Process does not hang — force exit guarantees termination

---

## 4. Observability

### 4.1 Structured Logging (`logger.ts`)
- JSON format to **stderr** (preserves stdout for MCP JSON-RPC transport)
- Fields: timestamp, level, subsystem, message, data, duration_ms, error, stack
- Log levels: debug, info, warn, error, fatal
- **Child loggers** with automatic context propagation (subsystem name)
- **Timer tracking** via `startTimer()` — measures operation duration with structured output
- **Circular reference protection** in JSON serialization — prevents crashes on cyclic objects

### 4.2 Prometheus Metrics (`metrics/index.ts`)
| Type | Metric | Labels |
|------|--------|--------|
| Counter | `scg_requests_total` | method, path, status |
| Counter | `scg_errors_total` | type |
| Counter | `scg_auth_failures_total` | reason |
| Histogram | `scg_request_duration_seconds` | method, path |
| Histogram | `scg_query_duration_seconds` | operation |
| Gauge | `scg_db_pool_total` | — |
| Gauge | `scg_db_pool_idle` | — |
| Gauge | `scg_db_pool_waiting` | — |

- **Cardinality explosion prevention**: max 10K metric series
- Per-route path pattern labels (not raw URLs with dynamic segments)

### 4.3 Request Correlation
- `X-Request-ID` header accepted from upstream or UUID auto-generated
- Correlation ID included in all error responses and log entries
- Length-capped at 128 characters to prevent header abuse

### 4.4 Health Endpoints
| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /health` | Kubernetes liveness | DB connectivity, pg_trgm extension, pool stats, cache stats, version, uptime |
| `GET /ready` | Kubernetes readiness | Migration status, DB connection |
| `GET /metrics` | Prometheus scrape | All counters, histograms, gauges in text format |

---

## 5. Caching

### 5.1 Architecture
- **In-process LRU cache** with TTL — no Redis dependency required
- 5 cache layers: symbol, profile, capsule, homolog, query
- Periodic cleanup every 60 seconds of expired entries
- `destroy()` method for clean shutdown (clears intervals)

### 5.2 Cache Invalidation
- **Automatic prefix-based invalidation** on incremental re-indexing for affected symbol versions
- Profile cache achieves high hit rates under normal analytical workloads
- Cache statistics exposed via `scg_cache_stats` MCP tool and HTTP endpoint

---

## 6. Data Retention & Lifecycle (`services/retention-service.ts`)

### 6.1 Retention Policy
- **Advisory-locked** execution prevents concurrent retention runs
- **4-phase cleanup**: stale transactions → snapshot expiry → snapshot cap → orphan cleanup
- Each phase runs independently — failure in one does not abort others
- Audit trail via `cleanup_log` table with operation type, target table, rows affected, and JSONB details

### 6.2 Snapshot Expiry
- Configurable maximum age (default 90 days, env: `SCG_SNAPSHOT_MAX_AGE_DAYS`)
- `retained_until` timestamp stamped on snapshots; past-expiry snapshots deleted
- **Protects the latest snapshot per repo** — never deletes the most recent regardless of age
- FK CASCADE handles all dependent rows (files, symbol_versions, profiles, relations, etc.)

### 6.3 Per-Repo Snapshot Cap
- Configurable maximum snapshots per repository (default 50, env: `SCG_MAX_SNAPSHOTS_PER_REPO`)
- Window function (ROW_NUMBER) for efficient cap enforcement
- Oldest snapshots beyond cap are deleted

### 6.4 Stale Transaction Cleanup
- Configurable timeout (default 60 minutes, env: `SCG_STALE_TXN_TIMEOUT_MINUTES`)
- Transactions in intermediate states (planned, prepared, patched, etc.) beyond timeout are marked `failed`
- Previous states recorded in audit log for debugging

### 6.5 Orphan Data Cleanup
- Evidence bundles with no referencing inferred_relations (older than 1 hour)
- Transaction file backups for terminal transactions older than 24 hours
- Controlled via `SCG_ORPHAN_CLEANUP_ENABLED` (default: true)

### 6.6 Scheduling
- Periodic automated execution (default every 6 hours, env: `SCG_RETENTION_INTERVAL_MINUTES`)
- Timer unref'd so it doesn't prevent graceful shutdown
- Cleanup on SIGTERM/SIGINT (timer cleared before pool close)
- Can be disabled entirely via `SCG_RETENTION_ENABLED=false`

---

## 7. Rate Limiting (`middleware/rate-limiter.ts`)

### 6.1 Implementation
- **O(1) token bucket** per client IP
- **Integer arithmetic** to prevent floating-point drift in token calculations
- **Retry-After header** on rate limit responses
- Periodic cleanup of idle buckets to prevent memory growth

### 6.2 Per-Route Configuration
| Route Category | Limit |
|---------------|-------|
| Ingestion (`scg_ingest_repo`) | 5 requests / 5 minutes |
| Expensive tools (blast radius, capsule, batch embed) | 20-30 requests / minute |
| Standard endpoints | 60 requests / minute |

### 6.3 Brute-Force Protection
- Per-IP failure tracking with exponential backoff
- Lockout up to 60 minutes after repeated authentication failures
- Stale failure records cleaned periodically

---

## 8. Configuration (`config.ts`)

All configuration via environment variables with sensible defaults:

| Variable | Purpose | Default |
|----------|---------|---------|
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `scg` |
| `DB_USER` | Database user | `scg` |
| `DB_PASSWORD` | Database password | — |
| `DB_SSL_MODE` | SSL mode (disable/allow/prefer/require) | `prefer` |
| `DB_POOL_MAX` | Max pool connections | `20` |
| `NODE_ENV` | Environment | `development` |
| `LOG_LEVEL` | Log level | `info` |
| `SCG_API_KEYS` | Comma-separated API keys | — |
| `SCG_ALLOWED_BASE_PATHS` | Comma-separated allowed repo paths | — |
| `PORT` | HTTP server port | `3100` |
| `SCG_SNAPSHOT_MAX_AGE_DAYS` | Maximum snapshot age before expiry | `90` |
| `SCG_MAX_SNAPSHOTS_PER_REPO` | Maximum snapshots retained per repository | `50` |
| `SCG_STALE_TXN_TIMEOUT_MINUTES` | Timeout for intermediate-state transactions | `60` |
| `SCG_RETENTION_INTERVAL_MINUTES` | Interval between automated retention runs | `360` |
| `SCG_RETENTION_ENABLED` | Enable automated retention scheduling | `true` |
| `SCG_ORPHAN_CLEANUP_ENABLED` | Enable orphaned data cleanup | `true` |

Production validation at startup:
- Rejects insecure passwords (common defaults)
- Enforces SSL for remote database hosts
- Validates API key minimum length (32 chars)
- Configuration summary logged with password redaction

---

## 9. Deployment

### 9.1 Docker
- **Multi-stage build**: builder → slim Alpine runtime
- **Non-root user** (`scg`) for container security
- Proper layer caching with dependency install first
- Python 3 + curl included for adapters and health checks
- Health check: `curl -sf http://localhost:3100/health` (30s interval, 5s timeout, 3 retries)

### 9.2 Docker Compose
- PostgreSQL 16-Alpine with `pg_isready` health check
- Service dependency with health condition (`service_healthy`)
- Named volume for data persistence
- `pg_trgm` extension created automatically

### 9.3 CI/CD
- GitHub Actions pipeline: TypeCheck → Lint → Tests → Build
- PostgreSQL 16 service container for integration tests
- Coverage artifact upload
- Node.js 22, Ubuntu latest

### 9.4 Express 5 Considerations
The HTTP server uses Express 5 (currently in RC). Express 5 includes:
- Native async error handling (no need for `express-async-errors`)
- Built-in promise rejection handling in route handlers
- `req.query` returns `undefined` for missing params (not empty string)

Monitor Express 5 for GA release and pin versions in production.
