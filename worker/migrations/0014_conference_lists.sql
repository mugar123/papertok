CREATE TABLE conference_editions (
  edition_id TEXT PRIMARY KEY,
  term INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  stale_since INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE conference_papers (
  edition_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_text TEXT,
  track TEXT CHECK (track IN ('oral', 'spotlight', 'poster')),
  sort_key TEXT NOT NULL,
  paper TEXT NOT NULL,
  seen_generation INTEGER NOT NULL,
  visible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (edition_id, paper_id)
);
CREATE INDEX conference_papers_page ON conference_papers (edition_id, visible, sort_key);

CREATE TABLE conference_paper_stage AS
  SELECT edition_id, paper_id, forum_id, venue_id, venue_text, track, sort_key, paper, seen_generation
  FROM conference_papers WHERE 0;
CREATE UNIQUE INDEX conference_stage_paper ON conference_paper_stage (edition_id, paper_id);
