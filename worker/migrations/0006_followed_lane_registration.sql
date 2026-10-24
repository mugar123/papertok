-- When a lane was first followed (paper-feed.ts `registerFollowedLanes`):
-- writing it again moves `requested_at`, never this. A lane never harvested
-- is due for the nightly refresh from then (paper-harvest.ts `followedJobs`),
-- so lanes followed after another lane's last refresh wait behind it. Rows
-- from before this migration take the time they were last written.
ALTER TABLE followed_lanes ADD COLUMN registered_at TEXT;
UPDATE followed_lanes SET registered_at = requested_at;
