-- Adding an iPhone from the iPhone itself, next to pasting its UDID: Safari downloads a
-- profile-service .mobileconfig, and iOS posts the UDID to /_nap/enroll/<token>. Each profile has
-- a single-use token that lasts a day, long enough for iOS's one-hour security delay on profile
-- installs away from familiar places. Only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS device_enrollments (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
