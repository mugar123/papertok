-- How far back a lane's backfill has read (paper-sources.ts backfillLane): the
-- day its listing ends at, and the next page to read, NULL once it is done.
ALTER TABLE lane_state ADD COLUMN backfill_until TEXT;
ALTER TABLE lane_state ADD COLUMN backfill_page INTEGER;
