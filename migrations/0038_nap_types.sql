-- A nap's type: 'page' (anything, the default) or 'dashboard'. It changes how Nap shows and
-- counts a nap, and which instructions agents read; more types may come. Every nap from before
-- is a page. Workers from before ignore the column, and their new naps get the default.
ALTER TABLE sites ADD COLUMN type TEXT NOT NULL DEFAULT 'page';

-- The type a pending direct upload or a draft asks for. NULL when it asks for none: a new nap is
-- a page, and an update keeps the type it has.
ALTER TABLE uploads ADD COLUMN nap_type TEXT;
ALTER TABLE drafts ADD COLUMN nap_type TEXT;
