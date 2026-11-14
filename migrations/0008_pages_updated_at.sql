-- list_pages reads newest-updated first, a page at a time, continuing from
-- (updated_at, id); this lets it read in that order and stop at the limit.
CREATE INDEX IF NOT EXISTS pages_updated_at ON pages (updated_at DESC, id DESC);
