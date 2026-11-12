-- Nap keeps the files (the upload and the signed build) of a platform's newest builds only. Once
-- a newer build goes live, older builds' files are deleted from R2 and files_deleted_at is set;
-- the row stays, for the build history.
ALTER TABLE app_builds ADD COLUMN files_deleted_at TEXT;
