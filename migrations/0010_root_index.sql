-- Whether a mockup set's served version has a root index.html, which then
-- replaces its gallery; the dashboard links option thumbnails by it. Set
-- whenever a set's options are synced (publish, update, patch, rollback).
-- NULL means not known yet: plain pages, and sets not synced since this
-- migration, which the dashboard checks in R2 once and records.
ALTER TABLE pages ADD COLUMN root_index INTEGER;
-- A set whose option is its root page (option `main` with no folder) has one.
UPDATE pages SET root_index = 1
WHERE kind = 'mockup' AND EXISTS (SELECT 1 FROM verdicts WHERE verdicts.page_id = pages.id AND verdicts.folder = 0);
