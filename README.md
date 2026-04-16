# ContextZero

**Code cognition engine for AI agents.** Indexes your codebase into a structured graph and serves precise, token-budgeted context via MCP. One call replaces 24 file reads.

Works with [Claude Code](https://claude.ai/), [Cursor](https://cursor.sh/), [Windsurf](https://codeium.com/windsurf), and any [MCP-compatible](https://modelcontextprotocol.io/) AI tool.

---

## Why ContextZero Exists

AI coding agents read files one at a time. To understand a single function change, they open 16 files, read 10,000+ lines, consume 40,000+ tokens — and still miss transitive side effects, contract violations, and duplicate code patterns.

**ContextZero eliminates this.** It indexes your codebase once, then serves precise, structured context in a single call.

---

## Measured Results

### Randomised head-to-head (reproducible)

On ContextZero's own codebase (98 files, 4,930 symbols), the benchmark in `scripts/bench-head-to-head.ts` picks 10 real random functions or classes. For each one it measures what an AI agent pulls into context **two ways**:

- **Traditional** — `grep -rlw <name>` + `Read` every file that matches.
- **ContextZero** — one `compile_context_capsule` call in strict mode.

Representative run (10 random targets, full transcript in the script):

| | Traditional | ContextZero | Reduction |
|--|-------------|-------------|-----------|
| **Tool calls** | 41 | 10 | **4.1× fewer** |
| **Files read** | 31 | — | — |
| **Tokens** | **408,447** | **45,436** | **9.0× fewer** |

Per-target token ratios range from **0.85×** (tiny isolated symbols) to **30.65×** (dependency-heavy symbols). The aggregate is the number to plan around.

```bash
# Reproduce on your own machine:
npm run build
DB_NAME=scg_v2 npx ts-node scripts/bench-head-to-head.ts 10
```

### Curated task-by-task comparison

Five concrete code-cognition tasks on the same codebase. File-reading numbers measure what an agent using only `Grep`/`Read` consumes; ContextZero numbers are the response size of a single MCP tool call.

### Task 1: "Understand this function and everything it depends on"

| | File Reading | ContextZero |
|--|-------------|-------------|
| Files opened | 6 | **0** |
| Lines consumed | 2,731 | **0** |
| Tokens consumed | 10,924 | **7,999** |
| Tool calls | 9 | **1** |
| What you get | Raw source code, figure it out yourself | Source + 13 dependencies pre-assembled + effect signature + inclusion rationale for every decision |

### Task 2: "What breaks if I change this function?"

| | File Reading | ContextZero |
|--|-------------|-------------|
| Files opened | 4 | **0** |
| Lines consumed | 4,823 | **0** |
| Tokens consumed | 19,292 | **~600** |
| Tool calls | 7 | **1** |
| What you get | List of files that mention the function name | **8 contract impacts** with severity scores, invariant violation predictions, confidence levels, and recommended validation scope |

**32x fewer tokens.** File reading *cannot* tell you which contract invariants will break.

### Task 3: "Does this function write to the database?"

| | File Reading | ContextZero |
|--|-------------|-------------|
| Files opened | 9 | **0** |
| Lines consumed | 6,195 | **0** |
| Tokens consumed | 24,780 | **~400** |
| Tool calls | 14 | **1** |
| What you get | Manually trace 9 files, hope you catch every call | **13 typed effects**: DB reads, DB writes, file I/O, HTTP calls, lock acquisition, event emission — with transitive call chain tracing and 0.95 confidence |

**62x fewer tokens.** A human reading files will miss a transitive DB write buried 3 call levels deep.

### Task 4: "Find all code similar to this function"

| | File Reading | ContextZero |
|--|-------------|-------------|
| Files opened | 8 | **0** |
| Lines consumed | 4,968 | **0** |
| Tokens consumed | 19,872 | **~2,000** |
| Tool calls | 11 | **2** |
| What you get | Grep results for similar names (noisy, misses different names) | **31 homologs** with 7-dimensional similarity scoring: semantic, logic, signature, behavioral, contract, test, and history — plus contradiction flags |

**10x fewer tokens.** Grep cannot find behaviorally similar code with different names.

### Task 5: "Give me everything I need to safely modify this function"

| | File Reading | ContextZero |
|--|-------------|-------------|
| Files opened | 16 | **0** |
| Lines consumed | 10,246 | **0** |
| Tokens consumed | 40,984 | **11,057** |
| Tool calls | 24 | **1** |
| What you get | 16 raw files dumped, 95% irrelevant to your change | Token-budgeted capsule: source + callers + **31 blast radius impacts** + severity scores + contract invariants, all in one call |

**3.7x fewer tokens. 24x fewer calls.** One call replaces an entire investigation.

### Total Across All 5 Tasks

| | File Reading | ContextZero | Difference |
|--|-------------|-------------|-----------|
| **Files opened** | 43 | **0** | -43 files |
| **Lines consumed** | 28,963 | **0** | -29K lines |
| **Tokens consumed** | 115,852 | **22,056** | **5.3x fewer** |
| **Tool calls** | 65 | **6** | **10.8x fewer** |

---

## What ContextZero Computes

| Capability | Description |
|-----------|-------------|
| **Capsule Compilation** | Token-budgeted context packages — source + deps + contracts + effects in one call. 5-level degradation ladder. |
| **Blast Radius** | 5-dimensional impact analysis (structural, behavioral, contract, homolog, historical) with severity and confidence scoring. |
| **Behavioral Profiling** | Every function classified: pure / read_only / read_write / side_effecting. Transitive propagation via topological sort. |
| **Effect Signatures** | 9 typed effects (reads, writes, opens, throws, calls_external, logs, emits, normalizes, acquires_lock) with transitive propagation. |
| **Contract Extraction** | Input/output types, error contracts, security contracts, guard clauses, derived invariants. |
| **Homolog Detection** | 7-dimensional evidence scoring with 4 contradiction flag types. Minimum 2 evidence families required. |
| **Smart Context** | One call: source + blast radius + callers + tests + contracts. Replaces 8+ separate lookups. |
| **Dispatch Resolution** | Class hierarchy, virtual call resolution, C3 linearization, field-sensitive points-to analysis. |
| **Concept Families** | 10 family types with exemplar identification, outlier detection, and contradiction flagging. |
| **Temporal Intelligence** | Git-derived co-change analysis, temporal risk scoring, churn metrics. |
| **Symbol Lineage** | Cross-snapshot identity tracking through renames and refactors. |
| **Transactional Editing** | 9-state lifecycle with DB-backed rollback. 6-level progressive validation. |
| **Semantic Search** | Find code by what it does: TF-IDF + MinHash LSH similarity. No external APIs. |
| **Uncertainty Tracking** | 12-source uncertainty model with per-symbol confidence scoring and evidence recommendations. |

## 13 Languages

TypeScript, JavaScript, Python, C++, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, Bash.

TypeScript/JavaScript: full AST analysis via TypeScript Compiler API. Python: LibCST with 60+ behavioral patterns. All others: tree-sitter with language-specific walkers.

## Architecture

```
AI Agent (Claude Code, Cursor, Windsurf, etc.)
    |
    | MCP protocol (stdio)
    |
ContextZero MCP Bridge (56 tools)
    |
    +-- Ingestor (13 languages, delta ingestion)
    +-- 13 Analysis Engines
    |     Behavioral | Contract | Deep Contract | Blast Radius
    |     Effect | Dispatch | Concept Families | Temporal
    |     Symbol Lineage | Runtime Evidence | Uncertainty
    |     Structural Graph | Capsule Compiler
    +-- Semantic Engine (TF-IDF, MinHash LSH, cosine similarity)
    +-- Homolog Engine (7-dimensional scoring, 5 candidate buckets)
    +-- Transactional Editor (9-state lifecycle, sandbox execution)
    +-- Service Layer (8 transport-agnostic services)
    +-- Database Driver (circuit breaker, batch loader, advisory locks)
    |
PostgreSQL 16 (all data local, nothing leaves your machine)
```

---

## Setup

### Prerequisites

- **Node.js** 20+ (22 recommended)
- **PostgreSQL** 14+ (16 recommended) with `pg_trgm` extension

### Install

```bash
git clone https://github.com/Ranjitbarnala0/ContextZero.git
cd ContextZero
npm install
```

### Database

```bash
createdb scg_v2
psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

Set environment variables (copy `.env.example` to `.env` and edit):

```bash
DB_HOST=localhost         # or an absolute path like /var/run/postgresql for unix-socket peer auth
DB_PORT=5432
DB_NAME=scg_v2
DB_USER=your_user
DB_PASSWORD=your_password # empty string OK when NODE_ENV != production
NODE_ENV=development
LOG_LEVEL=info
SCG_ALLOWED_BASE_PATHS=/path/to/one/or/more/code/dirs,separated,by,commas
SCG_API_KEYS=generate-with-openssl-rand-hex-32    # only enforced by HTTP server
```

Build, migrate, start:

```bash
npm run build
npm run db:migrate     # applies all 17 migrations
npm start              # HTTP server on port 3100
# or
npm run mcp            # MCP stdio bridge
```

Run the test suite if you want to verify your install:

```bash
npm test               # 40 suites / 1,441 tests / ~15s, 100% pass on a clean DB
```

### Connect to Claude Code

```bash
claude mcp add contextzero -s user \
  -e DB_HOST=localhost \
  -e DB_PORT=5432 \
  -e DB_NAME=scg_v2 \
  -e DB_USER=your_user \
  -e DB_PASSWORD=your_password \
  -e NODE_ENV=development \
  -e LOG_LEVEL=warn \
  -e SCG_ALLOWED_BASE_PATHS=/your/code/directory \
  -- node /path/to/ContextZero/dist/mcp-bridge/index.js
```

### Docker

```bash
docker compose up -d
```

### Verify

Ask Claude Code to run `scg_health_check`. You should see `status: healthy` with DB latency and version.

### Index your first repository

The most common setup mistake is not telling ContextZero which directories it is allowed to read. It fails closed by design — if `SCG_ALLOWED_BASE_PATHS` is empty, **every** repository call is rejected. Set it to the parent directory that contains the repos you want to index (comma-separated if more than one):

```bash
# .env (or MCP -e flags, or docker-compose env)
SCG_ALLOWED_BASE_PATHS=/home/me/code,/home/me/work
```

Then, from your AI tool, call `scg_ingest_repo` with **just the absolute path** — ContextZero auto-registers the repo on first call, so you don't have to run `scg_register_repo` separately:

```jsonc
// Claude Code / Cursor / Windsurf — ask the assistant to run this tool:
{
  "tool": "scg_ingest_repo",
  "repo_path": "/home/me/code/my-project"
}
```

Or hit the HTTP API directly:

```bash
curl -X POST http://localhost:3100/scg_ingest_repo \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $SCG_API_KEYS" \
  -d '{"repo_path": "/home/me/code/my-project"}'
```

What happens:

1. ContextZero checks that `/home/me/code/my-project` is under one of the allowed base paths.
2. It requires the directory to be a git repository (`git init` one if needed).
3. It auto-registers the repo, creates a snapshot at the current `HEAD`, and runs all 13 analysis engines. Typical throughput is ~3 files/sec.
4. Subsequent calls to `scg_incremental_index` on the same repo only re-analyse files whose content hash changed.

After ingestion completes you can use any of the 61 MCP tools against this repo. For a full guided first query, ask your AI assistant: *"Compile a strict context capsule for the largest function in my-project."* That runs a single `scg_compile_context_capsule` call and returns the target + blast radius + callers + contracts pre-assembled.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `column "created_at" does not exist` during `npm run db:migrate` | Running against a database populated by an older checkout before migration 014 was self-contained | Drop the DB (`dropdb scg_v2`) and re-run migrations from scratch, or apply only the missing migrations |
| `Refusing to connect to a remote database without SSL in production` | `NODE_ENV=production` with a `DB_HOST` the config doesn't recognise as local | Use `localhost`, `127.0.0.1`, `::1`, or a Unix socket path starting with `/` (e.g. `/var/run/postgresql`). For a genuinely remote DB, set `DB_SSL_MODE=require` |
| `repo_path is not a git repository (no .git found)` when calling a workspace tool | Target directory isn't under version control | `git init` the directory or point to a real repo root |
| `pg_trgm extension is NOT installed` warning in logs | Extension missing from the database | `psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"` |
| `Allowed base path violation: repo_path is not under any configured SCG_ALLOWED_BASE_PATHS` | The directory you passed is outside every path in `SCG_ALLOWED_BASE_PATHS` (fail-closed by design) | Add the parent directory (or the repo itself) to `SCG_ALLOWED_BASE_PATHS` — comma-separated for multiple roots — then restart the server |
| `Repository not found. Register it first via scg_register_repo` when passing a `repo_id` | The UUID doesn't exist in the registry | Pass `repo_path` instead of `repo_id` — `scg_ingest_repo` auto-registers on first call, or list existing repos with `scg_list_repos` |
| `Database overloaded: N queries waiting (max 40). Rejecting to prevent cascade.` on heavy workloads | Pool pressure guard firing | Lower ingestion concurrency, or raise `DB_MAX_CONNECTIONS` in `.env` (default is 20) |

---

## 61 MCP Tools

| Category | Tools | Count |
|----------|-------|-------|
| **Core** | `scg_health_check` `scg_register_repo` `scg_list_repos` `scg_ingest_repo` `scg_incremental_index` `scg_codebase_overview` `scg_snapshot_stats` `scg_cache_stats` | 8 |
| **Symbol Intelligence** | `scg_resolve_symbol` `scg_get_symbol_details` `scg_get_symbol_relations` `scg_read_source` `scg_search_code` `scg_semantic_search` `scg_get_tests` `scg_get_neighbors` | 8 |
| **Behavioral & Contract** | `scg_get_behavioral_profile` `scg_get_contract_profile` `scg_get_invariants` `scg_get_uncertainty` `scg_get_effect_signature` `scg_diff_effects` `scg_explain_relation` `scg_find_concept` | 8 |
| **Impact Analysis** | `scg_blast_radius` `scg_compile_context_capsule` `scg_smart_context` `scg_find_homologs` `scg_persist_homologs` `scg_propagation_proposals` `scg_semantic_diff` `scg_contract_diff` | 8 |
| **Change Planning** | `scg_plan_change` `scg_prepare_change` `scg_apply_propagation` `scg_review_homolog` | 4 |
| **Code Graph** | `scg_get_dispatch_edges` `scg_get_class_hierarchy` `scg_get_symbol_lineage` `scg_get_co_change_partners` `scg_get_temporal_risk` `scg_get_runtime_evidence` `scg_get_concept_family` `scg_list_concept_families` | 8 |
| **Transactional Editing** | `scg_create_change_transaction` `scg_get_transaction` `scg_apply_patch` `scg_validate_change` `scg_commit_change` `scg_rollback_change` | 6 |
| **Data Management** | `scg_list_snapshots` `scg_batch_embed` `scg_ingest_runtime_trace` | 3 |
| **Native Workspace** | `scg_native_codebase_overview` `scg_native_symbol_search` `scg_native_search_code` | 3 |
| **Admin & Operations** | `scg_admin_system_info` `scg_admin_db_stats` `scg_admin_retention_stats` `scg_admin_run_retention` `scg_admin_cleanup_stale` | 5 |

The 3 **Native Workspace** tools work without a database — they analyze the filesystem directly and are available immediately without ingestion. The 5 **Admin** tools expose system diagnostics and manual retention operations for operators.

---

## HTTP API

55 routes (4 GET + 51 POST) at `http://localhost:3100/`. Same capabilities as MCP tools.

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness check with DB stats |
| `GET /ready` | Readiness check (migration status) |
| `GET /metrics` | Prometheus metrics |
| `GET /scg_cache_stats` | Cache hit/miss stats |
| `POST /scg_*` | All 51 tool endpoints (same params as MCP) |

All POST routes require API key authentication (Bearer token or X-API-Key header).

---

## Security

- **Zero SQL injection surface** — 100% parameterized queries, table/column allowlist
- **5-layer path traversal protection** — null bytes, URL-encoding, backslash, symlink escape, boundary enforcement
- **Fail-closed auth** — timing-safe comparison, 32-char minimum, per-IP brute-force lockout with exponential backoff
- **Sandboxed execution** — ulimit, process groups, SIGKILL escalation, env sanitization
- **No data leaves your machine** — no telemetry, no external APIs, fully local
- **Circuit breaker** on DB connections with exponential backoff retry
- **Input validation** on every route — UUID, bounded integers, string length, patch size limits
- **Error sanitization** — no stack traces, internal paths, or SQL in error responses

---

## Testing

```bash
npm test              # Full test suite
npm run test:ci       # With coverage
npm run typecheck     # TypeScript strict mode
```

Integration tests with real PostgreSQL. Unit tests for all analysis engines, adapters, handlers, security, and caching.

---

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, subsystems, tool registry |
| [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) | Data structures, algorithms, engine internals |
| [PRODUCTION_HARDENING.md](PRODUCTION_HARDENING.md) | Security, resilience, observability, deployment |

---

## License

ISC
