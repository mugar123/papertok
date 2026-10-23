-- Where each leaf's arXiv papers sit among the vectors (worker/leaf-filing.ts):
-- the mean of the newest ones' vectors, recomputed by every harvest and read
-- by the step that files an area's journal articles under its leaves.
CREATE TABLE leaf_centroids (
  leaf TEXT PRIMARY KEY,
  -- int8 components of the unit vector times 127, as `work_vectors`.
  embedding BLOB NOT NULL,
  -- How many papers the mean was taken over.
  papers INTEGER NOT NULL,
  computed_at TEXT NOT NULL
) WITHOUT ROWID;
