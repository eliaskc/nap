-- iPhones are added by pasting their UDID in the dashboard instead of an enrollment profile.
-- devices.email is now who added the iPhone; name is what they called it.
DROP TABLE IF EXISTS device_enrollments;
ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT '';
