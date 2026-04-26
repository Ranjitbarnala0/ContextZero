# Migration Drift — Reconciled

**Status as of 2026-04-26:** drift between on-disk `db/migrations/` and the
live `_migrations` table has been resolved on the dev database. Production
deployments need a one-shot `_migrations.checksum` patch (see "Production
deploy steps" below) but no code changes.

## What was wrong (pre-fix)

1. **Migration count mismatch** — disk had 15 files, `_migrations` had 17 rows
   applied. The two missing files were `016_widen_commit_sha.sql` and
   `017_add_snapshots_created_at.sql`.
2. **Schema-incorrect 015 on disk** — `015_temporal_and_retention_indexes.sql`
   referenced `created_at` on `temporal_co_changes`, `temporal_risk_scores`,
   and `runtime_observed_edges`. Those columns don't exist in the production
   schema (real names: `computed_at`, `computed_at`, `first_observed`).
   A fresh-DB bootstrap from this content would fail with
   `column "created_at" does not exist`.
3. **Whitespace / comment drift in 014** — file content drifted from what was
   originally applied; checksum mismatch but DDL semantics unchanged.

## What was fixed

1. **`db/migrations/015_temporal_and_retention_indexes.sql`** — rewritten to
   reference the columns that actually exist in production. Verified by
   directly executing the new SQL against the live DB (succeeds — all
   `IF NOT EXISTS` guards make it idempotent).
2. **`db/migrations/016_widen_commit_sha.sql`** — recreated. Idempotent: a
   `DO` block widens `snapshots.commit_sha` to `VARCHAR(128)` only if the
   current width is < 128.
3. **`db/migrations/017_add_snapshots_created_at.sql`** — recreated. Uses
   `ADD COLUMN IF NOT EXISTS`, so re-applying is a no-op.
4. **`scripts/repair-migration-checksums.ts`** — new helper that detects
   checksum drift between disk and `_migrations` and patches the table
   in a single transaction. Run as `--apply`, otherwise dry-run.
5. **Local dev DB** — `_migrations.checksum` patched via the script above.
   `npm run db:migrate` now reports "All migrations already applied".

## Production deploy steps

Production databases (and any other already-migrated environment) still
have the old stored checksums and would throw on next startup
(`src/db-driver/migrate.ts:104-110`). One-shot operator step:

```bash
# Dry-run first to see what will change
npx ts-node scripts/repair-migration-checksums.ts

# Apply
npx ts-node scripts/repair-migration-checksums.ts --apply
```

The script connects via the same `DB_*` env vars as the server, so it can
target any environment. It updates only `_migrations.checksum` for files
whose on-disk SHA differs from what's stored — no DDL is executed and the
schema is unchanged.

## Fresh-DB bootstrap

A brand-new database now bootstraps cleanly:

1. `npm run db:migrate` runs all 17 files in order.
2. The rewritten 015 succeeds because it uses the real column names.
3. 016/017 have idempotent guards, so they run cleanly even though their
   effects are already applied via the original (now lost) source.

## Files to keep / discard

- `db/migrations/{014,015,016,017}_*.sql` — keep, they are the source of
  truth.
- `scripts/repair-migration-checksums.ts` — keep, useful for any future
  drift event and required for prod deploys of this commit.
- `scripts/introspect-drift.ts` and `scripts/verify-migrations.ts` —
  ad-hoc diagnostic tools used during this fix; safe to keep or delete.
