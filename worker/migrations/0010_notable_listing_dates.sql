-- How long a notable lane (paper-sources.ts `openalex-notable`) keeps a paper:
-- 14 days after the weekly listing that last returned it, written with the row
-- (paper-store.ts `ingestPapers`). Eviction drops the row then, though a like,
-- the paper's date or another lane keeps the paper in the corpus
-- (`evictExpired`). NULL on every other lane, whose rows stay while the paper
-- does. The Worker writes this column with every lane row, so apply this
-- migration before deploying it.
ALTER TABLE work_lanes ADD COLUMN listed_until TEXT;
