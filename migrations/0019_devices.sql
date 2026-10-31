-- iPhones that may install apps. Ad hoc signing only installs on devices listed in the signing
-- profile, so a person adds their iPhone from the dashboard: Safari downloads a profile-service
-- .mobileconfig, iOS posts the UDID back to /_nap/enroll/<token>, and Nap registers the device
-- with Apple and makes a new profile with every registered device.
CREATE TABLE IF NOT EXISTS devices (
  udid TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  asc_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The dashboard makes a single-use token for each enrollment profile it hands out. iOS posts to
-- /_nap/enroll/<token> without the Access cookie; the token says who asked. Only the SHA-256 hash
-- is stored.
CREATE TABLE IF NOT EXISTS device_enrollments (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- A new device means a new profile, so builds are signed again with it. Nap does that when
-- someone installs a build whose signature predates the current profile. signed_key is where that
-- build's newest .ipa is; NULL for builds signed before this migration (apps/.../signed.ipa).
ALTER TABLE app_builds ADD COLUMN signed_key TEXT;
ALTER TABLE app_builds ADD COLUMN signed_profile TEXT;
