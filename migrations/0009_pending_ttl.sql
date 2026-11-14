-- The ttl a placeholder page from upload_url is waiting to get, in
-- milliseconds, or 0 for permanent; NULL when nothing is pending. The first
-- new version applies it (from that moment) and clears it, and so does the
-- owner setting the expiry themselves.
ALTER TABLE pages ADD COLUMN pending_ttl INTEGER;
