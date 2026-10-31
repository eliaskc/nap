CREATE TABLE IF NOT EXISTS site_documents (
  id TEXT PRIMARY KEY,
  site_slug TEXT NOT NULL,
  collection TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
  created_by_email TEXT NOT NULL,
  updated_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  FOREIGN KEY (site_slug) REFERENCES sites(slug),
  FOREIGN KEY (created_by_email) REFERENCES profiles(email),
  FOREIGN KEY (updated_by_email) REFERENCES profiles(email)
);

CREATE INDEX IF NOT EXISTS idx_site_documents_collection
ON site_documents(site_slug, collection, created_at DESC, id DESC)
WHERE deleted_at IS NULL;
