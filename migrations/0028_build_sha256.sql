-- The SHA-256 (hex) of what a build ships, for platforms whose devices download the build from
-- Nap and check it: the reMarkable launcher downloads its zip as it was uploaded.
ALTER TABLE app_builds ADD COLUMN sha256 TEXT;
