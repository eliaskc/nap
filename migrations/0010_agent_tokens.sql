-- Agent sign-in. An agent asks for a device code. The user approves it on /connect, behind
-- Access. The agent then gets a token. Nap stores only SHA-256 hashes of codes and tokens.

-- The last time this person used Nap through Access. A token stops working when its owner has
-- not been seen for 30 days, so people that Access removes lose their tokens on their own.
ALTER TABLE profiles ADD COLUMN last_seen_at TEXT;

CREATE TABLE IF NOT EXISTS device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  -- City and country of the request, shown on the approval page.
  requested_from TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  approved_by_email TEXT,
  approved_at TEXT,
  denied_at TEXT,
  -- Set when the agent exchanges the approved code. A code gives one token.
  token_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_codes_expires_at ON device_codes(expires_at);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  client_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (email) REFERENCES profiles(email)
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_email ON agent_tokens(email);
