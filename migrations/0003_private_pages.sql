-- 'public' pages are served to anyone with the URL. 'private' ones need a
-- pass in the path (/<id>/~<pass>/), which signing in through Access or the
-- page's password hands out. Bumping share_epoch revokes every pass.
ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE pages ADD COLUMN password_hash TEXT;
ALTER TABLE pages ADD COLUMN share_epoch INTEGER NOT NULL DEFAULT 0;
