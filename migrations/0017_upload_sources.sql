-- A new site can get its source repo with its first upload, so its first version is built from a
-- commit. The upload holds the repo until it is committed; then the site gets it. An upload that
-- expires deletes its repo with its files.
ALTER TABLE uploads ADD COLUMN source_repo TEXT;
