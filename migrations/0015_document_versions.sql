-- Collections, second version.
-- id: chosen by Nap (a UUID) or by the app (put). Unique within a site and collection, so the
--   primary key is (site_slug, collection, id), and SQLite needs a table rebuild for that.
-- version: starts at 1 and goes up by one on every write, delete included. Conditional writes
--   compare it.
-- seq: goes up on every write within a site, delete included. The changes feed reads rows after a
--   seq, so deletes stay in the table as tombstones.
CREATE TABLE site_documents_new (
  site_slug TEXT NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL,
  created_by_email TEXT NOT NULL,
  updated_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  PRIMARY KEY (site_slug, collection, id),
  FOREIGN KEY (site_slug) REFERENCES sites(slug),
  FOREIGN KEY (created_by_email) REFERENCES profiles(email),
  FOREIGN KEY (updated_by_email) REFERENCES profiles(email)
);

INSERT INTO site_documents_new (
  site_slug, collection, id, data_json, version, seq, created_by_email, updated_by_email,
  created_at, updated_at, deleted_at
)
SELECT
  site_slug, collection, id, data_json, 1,
  ROW_NUMBER() OVER (PARTITION BY site_slug ORDER BY updated_at, id),
  created_by_email, updated_by_email, created_at, updated_at, deleted_at
FROM site_documents;

DROP TABLE site_documents;
ALTER TABLE site_documents_new RENAME TO site_documents;

CREATE INDEX idx_site_documents_collection
ON site_documents(site_slug, collection, created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_site_documents_seq ON site_documents(site_slug, seq);

CREATE INDEX idx_site_documents_changes ON site_documents(site_slug, collection, seq);
