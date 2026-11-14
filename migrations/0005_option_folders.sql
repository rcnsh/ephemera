-- Whether an option lives in its own top-level folder (`a/`) or is the set's
-- root page (a set that is just an index.html, option 'main'). Worked out from
-- the files when options are synced, so nothing has to guess or ask R2.
ALTER TABLE verdicts ADD COLUMN folder INTEGER NOT NULL DEFAULT 1;
-- Existing rows: a lone 'main' was a root page unless it was a main/ folder,
-- which can't be told apart here; the next update of such a set corrects it.
UPDATE verdicts SET folder = 0
WHERE option = 'main' AND (SELECT COUNT(*) FROM verdicts AS others WHERE others.page_id = verdicts.page_id) = 1;
