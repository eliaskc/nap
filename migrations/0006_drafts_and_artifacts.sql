-- Agent uploads land here first. A signed-in person claims a draft to publish it.
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'artifact' CHECK (kind IN ('site', 'artifact')),
  title TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  -- Claim id of an earlier draft. Publishing this draft can update the site that draft became.
  replaces_draft_id TEXT,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by_email TEXT,
  site_slug TEXT,
  version_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_drafts_expires_at ON drafts(expires_at);
CREATE INDEX IF NOT EXISTS idx_drafts_site_slug ON drafts(site_slug);

-- Artifacts are lightweight sites with a random id instead of a chosen slug.
-- They are served under artifacts.<root> and are not listed on the dashboard.
ALTER TABLE sites ADD COLUMN kind TEXT NOT NULL DEFAULT 'site' CHECK (kind IN ('site', 'artifact'));
CREATE INDEX IF NOT EXISTS idx_sites_kind ON sites(kind);
