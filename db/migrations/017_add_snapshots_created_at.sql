-- Add missing created_at column to snapshots table.
-- Retention queries and indexes (migrations 014, 015) reference created_at
-- but the column was never added to the original schema (001).
-- Default to indexed_at for existing rows; new rows get NOW().

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();

-- Backfill existing rows: use indexed_at as the creation timestamp
UPDATE snapshots SET created_at = indexed_at WHERE created_at = NOW();
