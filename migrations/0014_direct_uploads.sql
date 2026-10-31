-- Direct uploads. A client asks Nap for presigned R2 URLs, PUTs the files straight to R2, then
-- commits. The files go to sites/<site_slug>/versions/<version_id>/ at once; nothing points at
-- them until the commit records the version. Uncommitted uploads expire, and Nap deletes their
-- files.
-- creates: 1 for a new nap (site_slug is held for it until it expires), 0 for a new version.
-- files_json: [{ "path", "size", "contentType" }], checked against R2 at commit.
-- viewer_emails: JSON array, for visibility 'selected'.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'agent')),
  client TEXT NOT NULL DEFAULT '',
  site_slug TEXT NOT NULL,
  version_id TEXT NOT NULL,
  creates INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('site', 'artifact')),
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  owner_only INTEGER NOT NULL DEFAULT 1,
  expected_version TEXT,
  visibility TEXT CHECK (visibility IS NULL OR visibility IN ('private', 'everyone', 'selected')),
  viewer_emails TEXT NOT NULL DEFAULT '[]',
  files_json TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_uploads_pending ON uploads(expires_at) WHERE committed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_uploads_slug ON uploads(site_slug) WHERE committed_at IS NULL;
