-- One kind of thing: a nap. `kind` is kept for old rows but is no longer read.
-- listed: shown in the shared dashboard list. New naps are unlisted.
-- toolbar: Nap frames the page under a small bar with the title and Share. New naps have it.
ALTER TABLE sites ADD COLUMN listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1));
ALTER TABLE sites ADD COLUMN toolbar INTEGER NOT NULL DEFAULT 1 CHECK (toolbar IN (0, 1));

UPDATE sites
SET listed = CASE WHEN kind = 'site' THEN 1 ELSE 0 END,
    toolbar = CASE WHEN kind = 'artifact' THEN 1 ELSE 0 END;

CREATE INDEX IF NOT EXISTS idx_sites_created_by_email ON sites(created_by_email);
