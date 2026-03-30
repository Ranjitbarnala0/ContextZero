ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_base_path_unique
    ON repositories(base_path)
    WHERE base_path IS NOT NULL;
