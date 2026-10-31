CREATE TABLE IF NOT EXISTS profiles (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  username TEXT UNIQUE,
  avatar_color TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sites (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  updated_by_email TEXT NOT NULL,
  current_version TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  theme_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (created_by_email) REFERENCES profiles(email),
  FOREIGN KEY (updated_by_email) REFERENCES profiles(email)
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  site_slug TEXT NOT NULL,
  uploaded_by_email TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_slug) REFERENCES sites(slug),
  FOREIGN KEY (uploaded_by_email) REFERENCES profiles(email)
);

CREATE INDEX IF NOT EXISTS idx_sites_sort_order ON sites(sort_order);
CREATE INDEX IF NOT EXISTS idx_sites_updated_at ON sites(updated_at);
CREATE INDEX IF NOT EXISTS idx_versions_site_slug ON versions(site_slug);
