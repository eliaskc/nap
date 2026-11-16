-- How many times each person opened each site or artifact, and when they first did. Opens less
-- than 30 minutes after the last one are the same visit. Owners see this under "Visitors".
ALTER TABLE site_visits ADD COLUMN first_visited_at TEXT;
ALTER TABLE site_visits ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 1;
UPDATE site_visits SET first_visited_at = visited_at WHERE first_visited_at IS NULL;
