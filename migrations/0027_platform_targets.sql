-- An app's targets are its platforms: the iOS launcher, once "launcher", is now "ios". Each
-- platform has its own builds, build numbers, and live build (see src/lib/apps.ts).
UPDATE app_targets SET target = 'ios' WHERE target = 'launcher';
UPDATE app_builds SET target = 'ios' WHERE target = 'launcher';
