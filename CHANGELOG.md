# Changelog

All notable changes to ContextZero are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
