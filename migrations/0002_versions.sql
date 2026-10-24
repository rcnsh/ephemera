-- Every version a page keeps, so it can be listed and rolled back to.
-- Files live in R2 under pages/<page_id>/<version>/.
CREATE TABLE versions (
	page_id TEXT NOT NULL,
	version INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	size INTEGER NOT NULL,
	file_count INTEGER NOT NULL,
	PRIMARY KEY (page_id, version)
);

INSERT INTO versions (page_id, version, created_at, size, file_count)
SELECT id, version, updated_at, size, file_count FROM pages WHERE purged = 0;

-- `version` is the one being served; after a rollback it's older than
-- `latest_version`, the highest number handed out so far.
ALTER TABLE pages ADD COLUMN latest_version INTEGER NOT NULL DEFAULT 0;
UPDATE pages SET latest_version = version;
