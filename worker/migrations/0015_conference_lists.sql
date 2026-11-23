CREATE TABLE conference_editions (
  edition_id TEXT PRIMARY KEY,
  term INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  expected_count INTEGER NOT NULL DEFAULT 0,
  first_term_reported_count INTEGER NOT NULL DEFAULT 0,
  first_term_eligible_count INTEGER NOT NULL DEFAULT 0,
  term_eligible_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER,
  listed_count INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  search_completed_at INTEGER,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  next_recheck_at INTEGER NOT NULL DEFAULT 0,
  stale_since INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE conference_papers (
  edition_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_text TEXT,
  track TEXT CHECK (track IN ('oral', 'spotlight', 'poster')),
  sort_key TEXT NOT NULL,
  paper TEXT NOT NULL,
  seen_generation INTEGER NOT NULL,
  rechecked_at INTEGER NOT NULL DEFAULT 0,
  missing_from_search INTEGER NOT NULL DEFAULT 0,
  absent_days INTEGER NOT NULL DEFAULT 0,
  last_absent_day INTEGER,
  last_public_at INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (edition_id, forum_id)
);
CREATE INDEX conference_papers_page ON conference_papers (edition_id, visible, sort_key);
CREATE INDEX conference_papers_recheck ON conference_papers (rechecked_at, edition_id, forum_id);

CREATE TABLE conference_paper_stage (
  edition_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  venue_text TEXT,
  track TEXT CHECK (track IN ('oral', 'spotlight', 'poster')),
  sort_key TEXT NOT NULL,
  paper TEXT NOT NULL,
  seen_generation INTEGER NOT NULL,
  terms_seen INTEGER NOT NULL,
  PRIMARY KEY (edition_id, forum_id)
);

CREATE TABLE conference_forum_block (
  edition_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  blocked_at INTEGER NOT NULL,
  PRIMARY KEY (edition_id, forum_id)
);

CREATE TABLE conference_ingest_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
