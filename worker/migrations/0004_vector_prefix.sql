-- Vectors keep their leading 256 dimensions (paper-store.ts STORED_DIMENSIONS);
-- similarity normalizes them when it compares.
UPDATE work_vectors SET embedding = substr(embedding, 1, 256) WHERE length(embedding) > 256;
