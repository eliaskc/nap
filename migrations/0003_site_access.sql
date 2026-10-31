ALTER TABLE sites ADD COLUMN visibility TEXT NOT NULL DEFAULT 'everyone'
  CHECK (visibility IN ('everyone', 'private', 'selected'));

CREATE TABLE IF NOT EXISTS site_viewers (
  site_slug TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (site_slug, email),
  FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_site_viewers_email ON site_viewers(email);
