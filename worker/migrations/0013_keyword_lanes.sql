-- A keyword lane (`query:<text>`) keeps OpenAlex's rank of each paper in its
-- weekly any-age listing (paper-store.ts `writeLaneRanks`): 1 is the best
-- match. NULL on every other row. The lane's state holds how the keyword was
-- read at that listing (`phrase` or `words`) and when it ran.
-- Apply this migration before deploying the Worker that writes the columns,
-- in the same sitting and outside the nightly harvest: the lanes it empties
-- are filled again by the old search if an old Worker harvests them first.
ALTER TABLE work_lanes ADD COLUMN rank INTEGER;
CREATE INDEX work_lanes_rank ON work_lanes (lane, rank) WHERE rank IS NOT NULL;
ALTER TABLE lane_state ADD COLUMN reading TEXT;
ALTER TABLE lane_state ADD COLUMN catalogued_at TEXT;
-- The keyword lanes hold what the full-text search filed. By key range: a
-- LIKE reads the whole table.
DELETE FROM work_lanes WHERE lane >= 'query:' AND lane < 'query;';
DELETE FROM lane_state WHERE source = 'openalex-follows' AND lane >= 'query:' AND lane < 'query;';
