-- Kept apart from `kept_until`: a paper readers rank their feed by stays while
-- they do, even once no lane lists it any more (paper-store.ts `evictExpired`).
ALTER TABLE works ADD COLUMN liked_until TEXT;
