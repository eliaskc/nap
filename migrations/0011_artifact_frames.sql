-- Artifacts are at <root>/artifact/<slug>, framed in a sandbox. The sandboxed frame has an opaque
-- origin, so the browser may not send the Access cookie with its requests. Each viewer load makes a
-- frame token instead. The frame loads its files from <root>/_nap/frame/<token>/. Access bypasses
-- that path; the Worker checks the token and the viewer's access on every request.
-- Only the SHA-256 hash of a token is stored.
CREATE TABLE IF NOT EXISTS artifact_frames (
  token_hash TEXT PRIMARY KEY,
  site_slug TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_frames_expires_at ON artifact_frames(expires_at);
