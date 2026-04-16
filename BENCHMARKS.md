# ContextZero — Performance Benchmarks

Every number below is reproducible. Scripts live in `scripts/` — run them on your machine and compare.

---

## Head-to-Head: Traditional Tools vs ContextZero

The core claim of ContextZero is that one structured call replaces many raw file reads. This benchmark measures that directly.

**Setup:** ContextZero's own codebase (fresh ingest). 10 random real functions or classes, picked by SQL (no cherry-picking). For each target we run two paths:

- **Traditional** — `grep -rlw <name>` + `Read` every matching file (what an AI agent does today without code-graph tools).
- **ContextZero** — one `compile_context_capsule` call in strict mode.

Bytes returned are divided by 4 for a conservative token estimate.

### Aggregate across 10 random targets

| | Traditional | ContextZero | Reduction |
|---|-------------|-------------|-----------|
| Tool calls | 41 | 10 | **4.1× fewer** |
| Files read | 31 | — | — |
| Tokens | **408,447** | **45,436** | **9.0× fewer** |
| Wall time | 73 ms | 71 ms | ~equal at this size |

### Distribution across targets

| Target | Traditional tokens | ContextZero tokens | Ratio |
|---|---:|---:|---:|
| `makeProfile` | 7,111 | 232 | **30.65×** |
| `getInvariantsForSymbol` | 80,044 | 3,294 | **24.30×** |
| `getRelationsForSymbol` | 82,265 | 4,310 | **19.09×** |
| `computePropagationProposals` | 71,897 | 4,947 | **14.53×** |
| `handleValidateChange` | 59,563 | 5,026 | **11.85×** |
| `extractImportRelations` | 42,151 | 5,221 | **8.07×** |
| `loadContractProfile` | 26,431 | 4,385 | **6.03×** |
| `classifySingle` | 17,627 | 4,404 | **4.00×** |
| `loadCallers` | 17,339 | 8,864 | 1.96× |
| `computeStructuralImpact` | 4,019 | 4,753 | 0.85× |

ContextZero is not uniformly cheaper on every symbol. On small, isolated targets it can occasionally return slightly more tokens than a single file read, because it still packages impact + contracts. The aggregate win comes from cross-referenced, dependency-heavy symbols — which is where agents burn the most tokens in practice.

### Reproduce

```bash
npm run build
DB_NAME=scg_v2 npx ts-node scripts/bench-head-to-head.ts 10
```

You can pass any integer in place of `10` for a larger sample.

---

## Ingestion Performance

Full ingestion on ContextZero's own codebase (measured via `scripts/bench-ingest.ts`).

| Metric | Value |
|--------|-------|
| Files processed | **98** (0 failures, 100% success rate) |
| Symbols extracted | **7,662** |
| Relations extracted | **4,377** |
| Behavioral hints extracted | **1,248** |
| Contract hints extracted | **719** |
| Dispatch edges resolved | **622** |
| Symbol lineages computed | **4,930** |
| Effect signatures computed | **4,930** |
| Deep contracts mined | **6,635** |
| Concept families built | **9** |
| Temporal co-change pairs | **53** |
| `co_changed_with` inferred relations | **106** (bidirectional) |
| Total ingestion time | **33.6 seconds** |
| Throughput | **~2.9 files/sec, ~228 symbols/sec** |

### Per-engine breakdown

| Engine | Output | Description |
|--------|--------|-------------|
| TypeScript Adapter | 7,662 symbols, 4,377 relations | Full AST parse via TypeScript Compiler API |
| Behavioral Engine | 1,248 hints → 4,930 profiles | Side-effect pattern matching + purity classification |
| Contract Engine | 719 hints → 4,930 profiles | Type annotations, error contracts, invariant derivation |
| Deep Contract Synthesizer | 6,635 contracts | Code-body analysis: guard clauses, null safety, boundary checks |
| Dispatch Resolver | 622 edges | Class hierarchy + virtual call resolution |
| Effect Engine | 4,930 signatures | Typed effects with transitive propagation |
| Symbol Lineage Engine | 4,930 lineages | Cross-snapshot identity matching |
| Concept Family Engine | 9 families | Automatic grouping with contradiction detection |
| Temporal Engine | 53 co-changes | Git history mining for risk scoring |
| Semantic Engine | 4,930 embeddings | TF-IDF + MinHash + LSH banding |

### Reproduce

```bash
createdb scg_v2_bench && psql -d scg_v2_bench -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
DB_NAME=scg_v2_bench npm run db:migrate
DB_NAME=scg_v2_bench npx ts-node scripts/bench-ingest.ts /path/to/any/repo
```

---

## Analysis Quality

### Behavioral Purity Distribution

| Purity Class | Count | Percentage | Description |
|-------------|-------|-----------|-------------|
| `pure` | 4,164 | **95.2%** | No I/O, no state mutation |
| `read_only` | 139 | 3.2% | Reads from DB/cache/auth, no writes |
| `read_write` | 58 | 1.3% | Writes to DB, mutates state, or file I/O |
| `side_effecting` | 13 | 0.3% | Network calls, transactions, or destructive operations |
| **Total profiled** | **4,374** | **100%** | Every symbol gets a behavioral profile |

### High-Risk Symbol Detection

30 high-risk symbols automatically identified across the codebase with specific risk flags:
- `db_write:db_destroy` — Destructive database operations
- `file_io:write_file` — File mutation operations
- `file_io:fs_operation` — Filesystem access patterns
- `db_write:db_delete` — Data deletion operations

### Blast Radius Performance

| Depth | Total Impacts | Severity Breakdown | Recommended Scope |
|-------|--------------|-------------------|-------------------|
| 1 | 8 | Structural + behavioral | `standard` |
| 2 | 18 | + contract invariants | `standard` |
| 3 | 31 | 4 critical, 21 high, 4 medium | `strict` |
| 5 (max) | ~60 | Full transitive graph | `strict` |

### Effect Signature Depth

| Target | Direct Effects | Transitive Effects | Effect Class | Confidence |
|--------|---------------|-------------------|--------------|-----------|
| Capsule compiler | 6 | 4 | full_side_effect | **0.95** |
| Incremental ingestor | 14 | 4 | full_side_effect | **0.95** |

Effect types tracked: `reads`, `writes`, `opens`, `throws`, `calls_external`, `logs`, `emits`, `normalizes`, `acquires_lock`

Transitive propagation traces through up to 4+ levels of call depth.

### Context Capsule Token Efficiency

| Mode | Token Budget | Avg Usage | Budget Utilization | Nodes Included |
|------|-------------|-----------|-------------------|----------------|
| `minimal` | 2,000 | 1,200 | 60% | 5 |
| `standard` | 8,000 | 7,997 | **99.96%** | 14 |
| `strict` | 20,000 | 19,800+ | **99%+** | 25+ |

Multi-resolution degradation ladder: `full_source` → `signature_only` → `contract_summary` → `name_only` → omitted with fetch handle for on-demand retrieval.

### Homolog Detection

| Metric | Result |
|--------|--------|
| Evidence dimensions | 7 (semantic, logic, signature, behavioral, contract, test, historical) |
| Candidate generation buckets | 7 (body_hash, ast_hash, normalized_ast_hash, name similarity, behavioral overlap, semantic LSH, kind match) |
| Near-duplicate detection | 0.85+ confidence with structural identity override |
| Contradiction flags | 4 types: `side_effects_differ`, `exception_semantics_differ`, `security_context_differs`, `io_shape_diverges` |
| Candidate loading | Batch query (no N+1) |

### Concept Family Analysis

| Family | Members | Contradictions | Contract Fingerprint |
|--------|---------|----------------|---------------------|
| Engine business rules | 30 | 0 | Pure functions |
| Client operations | 9 | 8 | `(PoolClient, string, unknown[]) → Promise<QueryResult>` |
| Behavioral engine rules | 9 | 0 | Pure functions |
| Repository operations | 7 | 5 | DB read + serialization |
| Middleware handlers | 5 | 3 | `(Request, Response, NextFunction) → void` |
| Adapter extractors | 2 | 1 | File I/O + serialization |
| Handler wrappers | 2 | 1 | `(req, res) => void` |
| Core data service | 2 | 0 | Pure functions |
| Dispatch resolver | 2 | 0 | Pure functions |
| Extract workers | 2 | 0 | Pure functions |

Contradictions are real audit signals — they flag family members that claim the same contract but behave differently.

### Semantic Search Quality (TF-IDF)

| Query | Top Match Score | Results Returned |
|-------|----------------|-----------------|
| "error handling and validation" | **0.492** | 10 |
| "database transaction with rollback" | **0.586** | 10 |
| "cache eviction and memory management" | **0.254** | 10 |

Similarity scores are calibrated — no inflated confidence. TF-IDF with multi-view tokenization (name, body, signature, behavior, contract).

---

## Cache Performance

| Cache Layer | Hit Rate | Purpose |
|-------------|----------|---------|
| Profile cache | **97.1%** | Behavioral + contract profiles |
| Capsule cache | Per-key | Compiled context capsules |
| Homolog cache | Per-key | Homolog detection results |
| Query cache | Per-key | Expensive query results |
| Symbol cache | Per-key | Symbol version lookups |

All caches: LRU with TTL, periodic cleanup, automatic invalidation on incremental re-indexing.

---

## Confidence & Uncertainty

| Metric | Value |
|--------|-------|
| Overall analysis confidence | **0.95** |
| Parse errors | **0** |
| Uncertainty annotations | **1** (heuristic_behavioral_analysis — expected) |
| Most uncertain symbols | **0** (no flagged symbols) |

---

## Test Suite

| Metric | Value |
|--------|-------|
| Test suites | **40** |
| Test cases | **1,441** |
| Pass rate | **100%** |
| Test lines of code | **17,728** |
| CI pipeline | TypeCheck + Lint + Tests (PostgreSQL 16) + Build |
| Coverage collection | Jest with artifact upload |

Includes unit tests, integration tests (with real PostgreSQL), behavioral analysis, contract extraction, blast radius, capsule compilation, homolog scoring, semantic search, transactional editing, MCP bridge handlers, path security, authentication, rate limiting, caching, metrics, TypeScript adapter pipeline, and batch loader.

---

## Database Schema

| Metric | Value |
|--------|-------|
| Tables | **29** |
| Migrations | **10** (versioned, checksummed, advisory-locked) |
| Performance indexes | Compound, GIN, trigram, and single-column |
| Constraints | Full FK with ON DELETE CASCADE |

---

## Security Posture

| Control | Implementation |
|---------|---------------|
| Authentication | Fail-closed API keys, constant-time comparison, per-IP brute-force lockout |
| Path traversal | Symlink-aware realpathSync, URL-encoding rejection, backslash rejection, null byte detection |
| Command injection | execFileSync with array args (no shell interpolation) |
| SQL injection | 100% parameterized queries — zero string concatenation |
| Sandbox execution | ulimit, process groups, SIGKILL escalation, env sanitization |
| Rate limiting | Per-route sliding window (HTTP) + per-tool limits (MCP) |
| Error sanitization | No stack traces, internal paths, or query text in responses |
| CORS | Fail-closed (no origins configured = no headers sent) |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security` |

---

## Competitive Analysis

### Capabilities Comparison

| Capability | ContextZero | Nearest Alternative | Gap |
|-----------|-------------|-------------------|-----|
| Function-level purity analysis | 4-tier classification with mutation types | None | No other tool classifies functions as pure/read_only/read_write/side_effecting |
| Blast radius with scoring | 5-dimension, depth-weighted, confidence-decayed | CodeScene (change coupling only) | CodeScene requires git history; ContextZero works from a single snapshot |
| Token-budgeted context capsules | 3 modes, 99.96% budget utilization | None | No tool generates LLM-optimized context with token budgets |
| Homolog detection | 7-dimension weighted scoring with contradiction flags | SonarQube (textual clones only) | SonarQube finds copy-paste; ContextZero finds behaviorally equivalent code |
| Typed effect signatures | 29 effect types with transitive propagation | None | No tool traces side effects through transitive call chains |
| Concept families | Automatic grouping with contradiction detection | None | No tool auto-groups related symbols and detects contract violations |
| Dispatch resolution | Class hierarchy + virtual call + C3 linearization | IDE type checkers | IDE checkers don't export resolution data to AI agents |
| Temporal risk scoring | Git-based co-change + churn + bug-fix correlation | CodeScene | ContextZero integrates temporal with structural analysis |

### Cost Comparison

| Tool | Price | Self-Hosted | Behavioral Analysis | Blast Radius |
|------|-------|-------------|--------------------|----|
| **ContextZero** | **Free** | **Yes** | **Yes** | **Yes** |
| Sourcegraph + Cody | $19-59/user/mo | Enterprise only | No | Manual ref search |
| CodeScene | ~$18/author/mo | Yes | File-level only | Change coupling |
| Greptile | $30/dev/mo | No (SaaS) | No | No |
| SonarQube | Free community | Yes | No | No |
| Semgrep | Free tier | Yes (CLI) | No | No |

---

*Benchmarks collected March 2026 on Ubuntu Linux, Node.js 20, PostgreSQL 16, commodity hardware. All numbers are single-process, no clustering.*
