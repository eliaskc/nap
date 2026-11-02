-- TestFlight. On a Nap with napConfig.apps.testFlight, each build of that app's launcher is also
-- signed with the App Store profile and uploaded to App Store Connect, where Apple processes it
-- for the app's internal testers. testflight_state is null for builds that do not go to
-- TestFlight, else processing, ready, or failed (testflight_error says why). Nap asks Apple
-- about processing builds when someone looks, at most every testflight_checked_at + a few seconds.
ALTER TABLE app_builds ADD COLUMN testflight_state TEXT
  CHECK (testflight_state IN ('processing', 'ready', 'failed'));
ALTER TABLE app_builds ADD COLUMN testflight_error TEXT;
ALTER TABLE app_builds ADD COLUMN testflight_upload TEXT;
ALTER TABLE app_builds ADD COLUMN testflight_key TEXT;
ALTER TABLE app_builds ADD COLUMN testflight_checked_at TEXT;
