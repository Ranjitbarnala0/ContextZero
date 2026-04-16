# Changelog

All notable changes to ContextZero are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0]

### Added

- **Nested symbol extraction across all tree-sitter languages.** The
  universal adapter walker now descends into function bodies and resolves
  class-body containers by child type in addition to field name. Anonymous
  object method overrides — a common Kotlin pattern for listeners — are
  captured as first-class symbols with the enclosing class as parent.
  Kotlin property declarations resolve the identifier through the
  `variable_declaration` wrapper. Class-body functions are classified as
  `method` across every supported language. Measured on a 66-file Kotlin
  project: 566 symbols (235 methods, 171 properties, 88 classes, 72
  top-level functions) and 113 behavior hints.

- **Behavioral fingerprint gating for concept families.** The naming-pattern
  clustering step loads behavioral profiles and sub-buckets each suffix
  group by purity class and effect-set before forming families. Members
  within a family share compatible behavioral shape, eliminating
  false-positive groupings driven purely by name similarity. ContextZero
  self-ingest produces nine coherent families after this change.

### Changed

- **Call-graph edges are precise by default.** The TypeScript adapter
  emits only full call chains (`db.query`); the structural graph engine
  treats canonical names as a multi-map and drops ambiguous matches
  rather than resolving to an arbitrary candidate. Precise dispatch
  resolution remains the responsibility of the points-to analyzer. As a
  result, transitive behavioral propagation is tight: 27 `side_effecting`
  functions and 179 `read_only` functions on ContextZero's own codebase.

- **Benchmark documentation.** The README reports the median and
  p25–p90 distribution from `scripts/bench-head-to-head.ts` alongside
  three representative per-symbol comparisons. The reproduction
  invocation is documented next to the numbers.

- **Claude Code setup.** The MCP registration example uses
  `claude mcp add-json` for reliability with multi-env, subprocess-based
  stdio servers.

### Known limits

- Behavioral pattern matching does not yet detect SQL built via template
  literals or variable interpolation. Functions that build queries this
  way may report a lower purity class than the runtime behavior implies.
  The capability is tracked for a future release.

---

## [2.2.0] — Production-Ready Launch

### Fixed

- **Symbol lineage engine no longer silently returns zero results.** The
  `UPDATE symbols SET lineage_id = ...` statement previously used a freshly
  generated UUID that the surrounding `INSERT ... ON CONFLICT` had discarded,
  violating `symbols_lineage_id_fkey` on every re-ingestion. Lineage IDs are
  now looked up by `(repo_id, identity_seed)` so they always reference the
  row that actually exists. **Impact: 0 → 4,930 lineages per ingest** on
  ContextZero's own codebase.

- **Temporal engine no longer fails on the second ingest.** Co-change evidence
  bundles were inserting a fresh UUID with a constant score tuple, colliding
  with `uq_evidence_bundle_scores`. The `ON CONFLICT` clause targeted the
  wrong key. Now upserts against the score constraint and returns the
  existing bundle. **Impact: 0 → 53 temporal co-change pairs** surfaced
  per ingest.

- **Fresh database setup now works.** Migration 015 referenced
  `snapshots.created_at` (added only in 017) and `created_at` columns on
  three temporal tables that never had them (the tables use `computed_at`
  and `first_observed` respectively). Migration 014 now adds
  `snapshots.created_at` up front, and migration 015 references the actual
  column names. `createdb scg_v2 && npm run db:migrate` applies all 17
  migrations cleanly.

- **Production SSL check no longer rejects Unix sockets.** A `DB_HOST`
  starting with `/` is now recognised as a local path — node-postgres
  treats these as Unix socket directories, which cannot carry TLS and
  are inherently loopback. Unblocks peer-auth deployments.

- **100% test pass rate restored.** 40 suites, 1,441 tests, all passing.
  Three suites (`retention-service`, `workspace-native`, `db-config`)
  were updated to match service-level changes that had landed without
  corresponding test updates.

- **Zero vulnerabilities.** `npm audit fix` resolved 7 transitive-dep
  issues (1 critical, 3 high, 3 moderate) across handlebars, hono,
  path-to-regexp, and picomatch. No direct dependency changes.

### Changed

- `BENCHMARKS.md` now leads with a randomised head-to-head benchmark
  (10 real functions, grep+Read vs one capsule call). Aggregate: **9.0×
  fewer tokens, 4.1× fewer tool calls.** Script at
  `scripts/bench-head-to-head.ts` — anyone can re-run it.
- `README.md` documents all 61 MCP tools (was 56; 5 admin tools were
  implemented but undocumented).
- `README.md` setup section calls out supported `DB_HOST` forms and
  lists the `.env` keys operators actually need. Added a troubleshooting
  table.

### Added

- `scripts/bench-ingest.ts` — reproducible full-ingest benchmark.
- `scripts/bench-head-to-head.ts` — grep+Read vs ContextZero head-to-head
  benchmark across N random targets.
- `scripts/bench-capsule.ts` — per-mode capsule compilation measurements
  (minimal / standard / strict).

---

## [2.1.0]

Initial production release.
