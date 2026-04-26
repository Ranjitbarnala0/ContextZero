-- Migration 016: Widen snapshots.commit_sha to VARCHAR(128)
--
-- The original schema used VARCHAR(40) which fits a hex SHA-1 git commit but
-- not the longer workspace-fingerprint identifiers (e.g. "workspace-<32 hex>")
-- nor SHA-256 git hashes. 128 chars is comfortably above any plausible commit
-- identifier we want to support.
--
-- Idempotent: only runs ALTER TYPE when the column is still narrower than 128.

DO $$
DECLARE
    current_max INT;
BEGIN
    SELECT character_maximum_length INTO current_max
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'snapshots'
      AND column_name = 'commit_sha';

    IF current_max IS NULL THEN
        RAISE EXCEPTION 'snapshots.commit_sha column not found';
    END IF;

    IF current_max < 128 THEN
        ALTER TABLE snapshots ALTER COLUMN commit_sha TYPE VARCHAR(128);
    END IF;
END $$;
