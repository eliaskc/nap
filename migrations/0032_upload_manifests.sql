-- Direct uploads keep their file list in R2 (uploads/<id>/manifest.json): a D1 row holds at
-- most 2 MB, too little for uploads of many thousands of files. Open uploads started before this
-- migration can no longer commit; they expire and are cleaned up as usual.
ALTER TABLE uploads DROP COLUMN files_json;
