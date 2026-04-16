# ContextZero

**Code cognition engine for AI agents.** Indexes your codebase into a structured graph and serves precise, token-budgeted context through MCP.

Works with [Claude Code](https://claude.ai/), [Cursor](https://cursor.sh/), [Windsurf](https://codeium.com/windsurf), and any [MCP-compatible](https://modelcontextprotocol.io/) AI tool.

---

## Why ContextZero

Understanding a single function change means opening 10–20 files and still missing transitive side effects, contract violations, and near-duplicate implementations. ContextZero replaces that assembly step. One call returns the function plus its dependencies, callers, tests, contract profile, typed effect signature, and blast radius, pre-joined against a structured graph indexed from your repository.

For one-line lookups `grep` is still the right tool. For understanding unfamiliar code, changing code safely, or finding behaviorally similar code with different names, ContextZero is materially faster.

---

## Benchmarks

All numbers below are produced by `scripts/bench-head-to-head.ts` against a freshly-ingested snapshot of this repository. The script is deterministic given a seed and reproduces identically on any machine.

### Token reduction per task

A capsule call versus the equivalent `grep -rlw` plus reading every match in full:

| Task | grep + Read | ContextZero MCP | Reduction |
|---|---|---|---|
| Understand `ingestRepo` | 114,769 tok across 10 files | 7,604 tok, one `scg_smart_context` call | **15×** |
| Understand `queryWithClient` | 126,417 tok across 11 files | 224 tok, one `scg_compile_context_capsule` call (strict) | **564×** |
| Understand `computeBlastRadius` | 98,231 tok across 10 files | 916 tok, one `scg_compile_context_capsule` call (strict) | **107×** |

### Distribution across 50 random targets

| Percentile | Token reduction |
|---|---|
| p25 | 5.3× |
| **p50 (median)** | **10.2×** |
| p75 | 21.2× |
| p90 | 72.8× |
| max | 1,321× |

Plan around the median: **~10× fewer tokens for typical targets, 5–20× for the bulk of the distribution.**

### Methodology

- **Baseline** — `grep -rlw <symbol>` plus reading every matching file in full. This is the worst-case cost an agent pays when it has no structured index. A careful reader skimming ±50 lines per match sees ratios closer to 3–8×.
- **Token estimate** — `bytes / 4` (cl100k heuristic). Real tokenizers differ on JSON-heavy output, so the ContextZero side is conservative.
- **Reproduce on your own repository:**

    ```bash
    npm run build
    DB_NAME=scg_v2 npx ts-node scripts/bench-head-to-head.ts 50 /path/to/your/repo
    ```

### What grep cannot produce

A capsule for `queryWithClient` returns, in the same call:

- **Typed effect signature** — `reads(db.db_contextual_read, db.query) | logs(log.generic)`
- **Contract profile** — `Input: (PoolClient, string, unknown[]) → Output: Promise<QueryResult> | Errors: never`
- **Homolog matches** with contradiction flags — one match to `query`, flagged `side_effects_differ`
- **Blast radius** across 5 dimensions — 9 contract invariants with severity and confidence

None of these are reconstructible by reading source faster.

---

## What ContextZero computes

| Capability | What it actually does |
|-----------|-------------|
| **Capsule compilation** | Token-budgeted context packages — source + deps + contracts + effect signature in one call. Five degradation levels when the budget runs low. |
| **Blast radius** | Five-dimensional impact analysis (structural, behavioral, contract, homolog, historical) with per-impact severity and confidence. |
| **Behavioral profiling** | Every function classified as `pure` / `read_only` / `read_write` / `side_effecting`. Transitive propagation via topological sort on resolved call edges. |
| **Effect signatures** | Typed effects (`reads`, `writes`, `opens`, `throws`, `calls_external`, `logs`, `emits`, `normalizes`, `acquires_lock`) on each function, with transitive propagation. Per-function flags are conservative — derived from pattern matching on body text, not per-call-site evidence. |
| **Contract extraction** | Input / output types, error contracts, security contracts, guard clauses, and derived invariants. |
| **Homolog detection** | Seven-dimensional evidence scoring (semantic, logic, signature, behavioral, contract, test, history). Contradiction flags when two homologs disagree on side effects, error contract, security posture, or input shape. |
| **Smart context** | One call: source + blast radius + callers + tests + contracts. Designed to replace 8–12 separate lookups when you need to think about a change safely. |
| **Dispatch resolution** | Class hierarchy with C3 linearisation MRO, field-sensitive points-to from constructors / type annotations / DI params / factories, resolved per-chain so `self.service.repo.find()` maps to a concrete target. |
| **Concept families** | Member clusters discovered from homolog pairs and naming patterns, sub-bucketed by behavioral fingerprint (purity × effect-set) so unrelated symbols with the same name suffix don't end up in the same family. |
| **Temporal intelligence** | Git-derived co-change pairs with Jaccard scoring, temporal risk scoring, churn metrics. |
| **Symbol lineage** | Cross-snapshot identity tracking through renames and refactors via identity-seed matching. |
| **Transactional editing** | Nine-state lifecycle with DB-backed rollback, six-level progressive validation ladder. |
| **Semantic search** | TF-IDF + MinHash LSH on stripped AST bodies. Runs entirely local — no external APIs, no embeddings service. |
| **Uncertainty tracking** | Per-symbol confidence with twelve uncertainty sources; surfaced through `scg_get_uncertainty`. |

## Language support

13 languages parse, with different analysis depth per language:

| Depth | Languages | What you get |
|---|---|---|
| **Full semantic** | TypeScript, JavaScript | TypeScript Compiler API — full type resolution, accurate call graph, decorator capture, resolved dispatch |
| **Full structural (CST walk + behavioral patterns)** | Python | LibCST adapter with 60+ patterns |
| **CST-based walker + library pattern match** | Kotlin, Java, C#, C++, Rust, Go, Ruby, Swift, PHP, Bash | Tree-sitter with nested-body traversal and anonymous-object method extraction. Symbols, relations, inheritance, and behavioral hints work. Dispatch resolution falls back to name-based lookup. |

Behavioral pattern matching uses language-specific regexes (`Retrofit` / `OkHttpClient` for Kotlin, `reqwest` / `diesel` for Rust, `PDO` / `Eloquent` for PHP, etc.). The pattern catalogue is never complete — functions using unusual APIs or template-literal SQL may under-classify.

## Architecture

```
AI Agent (Claude Code, Cursor, Windsurf, etc.)
    |
    | MCP protocol (stdio)
    |
ContextZero MCP Bridge (61 tools)
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

The plain `claude mcp add` argument parser can get confused by the mix of env flags and the node subprocess. The JSON form is the most reliable:

```bash
claude mcp add-json --scope user contextzero '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/ContextZero/dist/mcp-bridge/index.js"],
  "env": {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_NAME": "scg_v2",
    "DB_USER": "your_user",
    "DB_PASSWORD": "your_password",
    "NODE_ENV": "development",
    "LOG_LEVEL": "warn",
    "SCG_ALLOWED_BASE_PATHS": "/your/code/directory"
  }
}'
```

For Unix-socket peer auth on Linux, set `"DB_HOST": "/var/run/postgresql"` and leave `DB_PASSWORD` empty. Restart Claude Code (or whichever MCP client you use) after registering — clients load their MCP list at process start.

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

60 routes (4 GET + 56 POST) at `http://localhost:3100/`. Same capabilities as MCP tools.

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
