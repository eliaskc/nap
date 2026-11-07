-- Apps go through TestFlight only: no ad hoc installs, no registered iPhones, and no standalone
-- apps. Only the launcher is published, so other targets and their builds go. Their files in R2
-- (apps/<app>/builds/<id>/) stay until someone deletes them; nothing reads them.
DROP TABLE IF EXISTS app_install_links;
DROP TABLE IF EXISTS device_enrollments;
DROP TABLE IF EXISTS devices;
DELETE FROM app_builds WHERE target <> 'launcher';
DELETE FROM app_targets WHERE target <> 'launcher';
