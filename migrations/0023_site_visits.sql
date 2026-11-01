-- The last time each person opened each site or artifact. The dashboard lists other people's
-- artifacts only when the person has opened them, and sorts by "recently visited".
CREATE TABLE IF NOT EXISTS site_visits (
  email TEXT NOT NULL,
  site_slug TEXT NOT NULL,
  visited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (email, site_slug),
  FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_site_visits_site ON site_visits(site_slug);
