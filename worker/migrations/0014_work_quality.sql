CREATE TABLE openalex_author_impact (
  author_id TEXT PRIMARY KEY,
  -- NULL records a successful lookup without an h-index. Zero is a measured value.
  h_index INTEGER CHECK (h_index >= 0),
  fetched_at TEXT NOT NULL,
  refresh_requested_at TEXT
) WITHOUT ROWID;

CREATE INDEX openalex_author_impact_fetched ON openalex_author_impact (fetched_at);

CREATE INDEX openalex_author_impact_refresh ON openalex_author_impact (refresh_requested_at, fetched_at)
  WHERE refresh_requested_at IS NOT NULL;

CREATE TABLE work_quality (
  work_id INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  published TEXT NOT NULL,
  max_h_index INTEGER CHECK (max_h_index >= 0),
  hf_upvotes INTEGER CHECK (hf_upvotes > 0),
  author_bonus REAL NOT NULL CHECK (author_bonus >= 0),
  hf_bonus REAL NOT NULL CHECK (hf_bonus >= 0),
  score REAL NOT NULL CHECK (score > 0 AND score <= 0.05),
  CHECK (COALESCE(max_h_index, 0) > 0 OR hf_upvotes IS NOT NULL)
);

-- Retained works can outlive their quality window.
CREATE INDEX work_quality_published ON work_quality (published);

CREATE TRIGGER work_quality_publication_changed AFTER UPDATE OF published ON works
WHEN NEW.published <> OLD.published
BEGIN
  DELETE FROM work_quality WHERE work_id = NEW.id;
END;
