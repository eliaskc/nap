-- Old URLs of naps that got a new key. An artifact's key is a random id, so a site that moves to
-- Artifacts gets a new id; its old slug stays here and redirects to <root>/artifact/<id>, from
-- both <slug>.<root> and <root>/artifact/<slug>. A redirect is never shown and never used to
-- serve files. A live nap with the same slug always wins over a redirect.
CREATE TABLE IF NOT EXISTS nap_redirects (
  slug TEXT PRIMARY KEY,
  site_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_nap_redirects_site_slug ON nap_redirects(site_slug);
