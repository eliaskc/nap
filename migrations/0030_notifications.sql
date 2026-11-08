-- Notifications (napConfig.notifications). Where they go: a phone with the app (APNs device
-- token) or a browser that turned them on (web push endpoint and its keys), by person.
CREATE TABLE IF NOT EXISTS push_targets (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'apns' or 'web'
  endpoint TEXT NOT NULL UNIQUE,   -- the APNs device token, or the web push endpoint URL
  p256dh TEXT,                     -- web push: the browser's public key
  auth TEXT,                       -- web push: the browser's auth secret
  environment TEXT,                -- APNs: 'production' (TestFlight) or 'sandbox' (debug builds)
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS push_targets_email ON push_targets (lower(email));

-- Every notification sent, for the rate limits and for looking back.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- 'site:<slug>' or 'app'
  sender_email TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS notifications_sender ON notifications (lower(sender_email), created_at);
CREATE INDEX IF NOT EXISTS notifications_source ON notifications (source, created_at);

-- Keys Nap makes for itself: the VAPID key pair that signs web push requests.
CREATE TABLE IF NOT EXISTS nap_keys (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
