-- Comments on artifacts. A thread starts with a comment, usually on selected text, and gets
-- replies. Anyone who can view the artifact can comment, reply, resolve, and reopen. Agents do
-- the same through the agent API for their owner's artifacts.
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  site_slug TEXT NOT NULL,
  -- The first comment of the thread. NULL for the first comment itself.
  thread_id TEXT,
  -- First comments only. The page (`/`, `/about.html`), the live version when it was written,
  -- and the selected text with up to 32 characters around it. An empty quote means the page.
  path TEXT NOT NULL DEFAULT '/',
  version_id TEXT,
  quote TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  author_email TEXT NOT NULL,
  -- The agent token's name when an agent wrote it.
  client TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- First comments only.
  resolved_at TEXT,
  resolved_by_email TEXT,
  FOREIGN KEY (site_slug) REFERENCES sites(slug),
  FOREIGN KEY (thread_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_site ON comments(site_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id);
