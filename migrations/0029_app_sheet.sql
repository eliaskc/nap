-- What a build has inside: the apps in the launcher, as JSON [{ "slug", "title", "summary" }],
-- read from each app's app.json by the publish script. Each platform has its own list.
ALTER TABLE app_builds ADD COLUMN contents TEXT;

-- When the person dismissed the dashboard's Get the app nudge. NULL: it still shows.
ALTER TABLE profiles ADD COLUMN app_nudge_dismissed_at TEXT;
