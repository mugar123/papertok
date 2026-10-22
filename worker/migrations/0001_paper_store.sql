CREATE TABLE papers (
  arxiv_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  -- JSON arrays, in arXiv's order: the primary category comes first.
  authors TEXT NOT NULL,
  categories TEXT NOT NULL,
  doi TEXT,
  journal_ref TEXT,
  comments TEXT,
  -- Submission date of v1, and of the latest version.
  published TEXT NOT NULL,
  updated TEXT NOT NULL
);

-- Apart from `papers` so that ranking reads vectors without abstracts.
-- int8 components of the unit vector times 127 (EMBEDDING_MODEL, 1024 dims).
CREATE TABLE paper_vectors (
  arxiv_id TEXT PRIMARY KEY REFERENCES papers(arxiv_id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE TABLE paper_categories (
  category TEXT NOT NULL,
  arxiv_id TEXT NOT NULL REFERENCES papers(arxiv_id) ON DELETE CASCADE,
  published TEXT NOT NULL,
  PRIMARY KEY (category, arxiv_id)
);

CREATE INDEX paper_categories_recent ON paper_categories (category, published DESC);
CREATE INDEX papers_published ON papers (published DESC);

-- One row per arXiv OAI set: the last day harvested to the end.
CREATE TABLE harvest_state (
  set_spec TEXT PRIMARY KEY,
  harvested_through TEXT NOT NULL
);
