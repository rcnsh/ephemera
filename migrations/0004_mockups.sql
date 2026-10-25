-- A mockup set is a page with kind 'mockup'. `project` groups sets in the
-- dashboard, as a slug. Mockups don't count towards the page limits.
ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';
ALTER TABLE pages ADD COLUMN project TEXT;

-- One row per option of a mockup set (its top-level folders), kept in step
-- with the version being served: 'pending' until someone picks or rejects it.
CREATE TABLE verdicts (
	page_id TEXT NOT NULL,
	option TEXT NOT NULL,
	verdict TEXT NOT NULL DEFAULT 'pending',
	note TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (page_id, option)
);
