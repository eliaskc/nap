-- Native apps. An app is a source repo (Cloudflare Artifacts) holding an Xcode project with one or
-- more targets: a launcher, or standalone apps. Agents build a target on a Mac without signing and
-- upload the .app with the commit it was built from. Nap signs it with the ad hoc certificate and
-- profile, keeps both the unsigned and the signed build, and points the target at the new build.
-- Builds are immutable. Re-signing (for a new device) writes a new signed file.
-- Everyone who can sign in to Nap can see, push to, and install every app.
CREATE TABLE IF NOT EXISTS apps (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_repo TEXT NOT NULL UNIQUE,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A target is one installable app. Its bundle id is <bundleIdPrefix>.<target>, so target names are
-- unique across apps. Build numbers only go up: iOS will not install a lower one over a higher one.
CREATE TABLE IF NOT EXISTS app_targets (
  app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
  target TEXT NOT NULL,
  bundle_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  live_build TEXT,
  next_build_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (app_slug, target)
);

-- status: signing, ready (signed; live unless a newer build replaced it), failed.
CREATE TABLE IF NOT EXISTS app_builds (
  id TEXT PRIMARY KEY,
  app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
  target TEXT NOT NULL,
  build_number INTEGER NOT NULL,
  source_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('signing', 'ready', 'failed')),
  error TEXT,
  notes TEXT NOT NULL DEFAULT '',
  app_name TEXT NOT NULL DEFAULT '',
  short_version TEXT NOT NULL DEFAULT '',
  xcode TEXT NOT NULL DEFAULT '',
  unsigned_bytes INTEGER NOT NULL DEFAULT 0,
  signed_bytes INTEGER NOT NULL DEFAULT 0,
  created_by_email TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_app_builds_target ON app_builds(app_slug, target, created_at);

-- Install links. iOS downloads the manifest and the .ipa itself, without the Access cookie, so
-- each install gets a short-lived token. Access bypasses /_nap/install/*; the Worker checks the
-- token. Only the SHA-256 hash of a token is stored.
CREATE TABLE IF NOT EXISTS app_install_links (
  token_hash TEXT PRIMARY KEY,
  build_id TEXT NOT NULL REFERENCES app_builds(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_install_links_expires_at ON app_install_links(expires_at);
