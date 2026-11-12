-- When a paper entered a lane, for the feeds that go day by day. NULL: it came
-- with the lane's first load, and counts from its publication date.
-- Apply this migration before deploying the Worker that writes the column.
ALTER TABLE work_lanes ADD COLUMN arrived TEXT;
CREATE INDEX work_lanes_arrival ON work_lanes (lane, COALESCE(arrived, published) DESC, published DESC);
