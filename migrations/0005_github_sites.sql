ALTER TABLE sites ADD COLUMN management_type TEXT NOT NULL DEFAULT 'direct' CHECK (management_type IN ('direct', 'github'));
ALTER TABLE sites ADD COLUMN source_repository TEXT;
ALTER TABLE sites ADD COLUMN source_directory TEXT;

CREATE TABLE site_deployments (
  site_slug TEXT PRIMARY KEY REFERENCES sites(slug),
  run_number INTEGER NOT NULL,
  source_commit TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  deployed_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'deployed')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE versions ADD COLUMN source_repository TEXT;
ALTER TABLE versions ADD COLUMN source_directory TEXT;
ALTER TABLE versions ADD COLUMN source_commit TEXT;
ALTER TABLE versions ADD COLUMN manifest_json TEXT;

-- These guards also prevent a rename/delete that began before conversion.
CREATE TRIGGER protect_github_site_delete BEFORE DELETE ON sites
WHEN OLD.management_type = 'github'
BEGIN SELECT RAISE(ABORT, 'GitHub-managed sites cannot be deleted'); END;
CREATE TRIGGER protect_github_site_slug BEFORE UPDATE OF slug ON sites
WHEN OLD.management_type = 'github' AND NEW.slug != OLD.slug
BEGIN SELECT RAISE(ABORT, 'GitHub-managed sites cannot be renamed'); END;
