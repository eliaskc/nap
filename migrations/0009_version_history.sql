-- Version history.
-- parent_version_id: the live version that this version replaced. NULL for the first version.
-- source: how it was published. '' for old rows where Nap cannot tell.
-- client: the agent token's name for agent uploads.
-- message: what changed, from the agent.
ALTER TABLE versions ADD COLUMN parent_version_id TEXT;
ALTER TABLE versions ADD COLUMN source TEXT NOT NULL DEFAULT ''
  CHECK (source IN ('', 'dashboard', 'agent', 'claim', 'github'));
ALTER TABLE versions ADD COLUMN client TEXT NOT NULL DEFAULT '';
ALTER TABLE versions ADD COLUMN message TEXT NOT NULL DEFAULT '';

UPDATE versions SET source = 'github' WHERE source_commit IS NOT NULL;
UPDATE versions SET source = 'claim'
WHERE source = '' AND id IN (SELECT version_id FROM drafts WHERE version_id IS NOT NULL);

-- Before this migration, a version replaced the one uploaded just before it. A GitHub upload that
-- lost promotion is the exception, but it is rare and does not change which version is live.
UPDATE versions
SET parent_version_id = (
  SELECT previous.id FROM versions AS previous
  WHERE previous.site_slug = versions.site_slug AND previous.created_at < versions.created_at
  ORDER BY previous.created_at DESC
  LIMIT 1
);

CREATE INDEX IF NOT EXISTS idx_versions_site_created ON versions(site_slug, created_at);
