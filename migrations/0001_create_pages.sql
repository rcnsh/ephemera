-- IF NOT EXISTS: the table predates migrations in production.
CREATE TABLE IF NOT EXISTS pages (
	id TEXT PRIMARY KEY,
	label TEXT,
	agent TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	expires_at INTEGER,
	deleted_at INTEGER,
	purged INTEGER NOT NULL DEFAULT 0,
	version INTEGER NOT NULL,
	size INTEGER NOT NULL,
	file_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pages_expires_at ON pages (expires_at);
