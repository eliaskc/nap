-- Someone without access to a nap asks its owner for it (napConfig.accessRequests). The owner
-- hears through the instance's channels (such as Slack) and answers there or on /requests/<id>.
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  site_slug TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  -- 'add' (invite them), 'everyone' (share with everyone), or 'deny'.
  decision TEXT,
  decided_by_email TEXT,
  decided_at TEXT,
  -- Where the owner was told, by channel, so the message can change once it is answered:
  -- {"slack": {"channel": "D123", "ts": "1700000000.000100"}}. '{}' when no channel reached them.
  channel_refs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (site_slug) REFERENCES sites(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS access_requests_site_email
  ON access_requests (site_slug, lower(email), created_at);
CREATE INDEX IF NOT EXISTS access_requests_email ON access_requests (lower(email), created_at);
