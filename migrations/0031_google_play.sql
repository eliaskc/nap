-- Google Play. On a Nap with napConfig.apps.android, each Android build is signed with the Play
-- upload key and, with a service account, uploaded to the internal testing track. play_state is
-- null for builds of other platforms, else:
--   released  a release on internal testing, which testers get from Google Play
--   draft     a draft release on internal testing: the app is still a draft in Play Console, so
--             someone rolls it out there by hand
--   manual    not uploaded (no service account, or Play would not take it through the API):
--             someone uploads the signed bundle in Play Console by hand
-- play_error says why a build is manual. play_key is the signed bundle in R2.
ALTER TABLE app_builds ADD COLUMN play_state TEXT
  CHECK (play_state IN ('released', 'draft', 'manual'));
ALTER TABLE app_builds ADD COLUMN play_error TEXT;
ALTER TABLE app_builds ADD COLUMN play_key TEXT;
