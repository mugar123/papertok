-- The paper corpus (worker/paper-store.ts): one row per paper, whichever
-- sources listed it, replacing the arXiv-only `papers` table of 0001.

CREATE TABLE works (
  id INTEGER PRIMARY KEY,
  -- The paper in the app's contract (src/models/paper.ts), as JSON.
  paper TEXT NOT NULL,
  -- The date the feed windows and orders by (ISO 8601).
  published TEXT NOT NULL,
  -- Removed once this has passed: the corpus window after `published`, or
  -- longer for a liked paper the feed ranks others against.
  kept_until TEXT NOT NULL,
  -- When OpenAlex was last asked about the work, and how often in a row it
  -- did not know it yet.
  enriched_at TEXT,
  enrich_misses INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX works_kept ON works (kept_until);
-- The embedding pass takes the newest papers without a vector first.
CREATE INDEX works_published ON works (published DESC);
CREATE INDEX works_enrichment ON works (enriched_at, published DESC);

-- Every identifier a work is known by (PaperBuilder.identityKeys), plus
-- `id:<paper id>`: a source's next record of the paper finds it here.
CREATE TABLE work_keys (
  key TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX work_keys_work ON work_keys (work_id);

-- What a reader can ask for: a category (`cs.LG`, `bio.gen`), a followed
-- entity (`author:A…`, `topic:T…`, …) or a series (`series:working-papers`).
CREATE TABLE work_lanes (
  lane TEXT NOT NULL,
  work_id INTEGER NOT NULL,
  published TEXT NOT NULL,
  PRIMARY KEY (lane, work_id)
) WITHOUT ROWID;

CREATE INDEX work_lanes_recent ON work_lanes (lane, published DESC);
CREATE INDEX work_lanes_work ON work_lanes (work_id);

-- Apart from `works` so that ranking reads vectors without papers.
-- int8 components of the unit vector times 127 (EMBEDDING_MODEL, 1024 dims).
CREATE TABLE work_vectors (
  work_id INTEGER PRIMARY KEY,
  embedding BLOB NOT NULL
);

-- How far each source's harvest of a lane has reached.
CREATE TABLE lane_state (
  source TEXT NOT NULL,
  lane TEXT NOT NULL,
  harvested_through TEXT NOT NULL,
  PRIMARY KEY (source, lane)
) WITHOUT ROWID;

-- Followed entities readers asked the feed for, harvested every day while asked.
CREATE TABLE followed_lanes (
  lane TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL
) WITHOUT ROWID;
