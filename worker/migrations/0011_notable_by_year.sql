-- Forgets when each notable lane (paper-sources.ts `openalex-notable`) was
-- last listed, once, so that the first by-year listing (ENG-129) runs for every
-- lane on one night. The weekly listing before it marked all 39 lanes, and
-- `notableLaneJobs` lists every lane without a mark but at most eight marked
-- ones a night, so the conversion would otherwise take five nights from a
-- week after that listing. Only the listing marks go: the lanes' rows
-- (`work_lanes`) and their `listed_until` stay, and nothing leaves the
-- corpus. Apply this migration after deploying the Worker that lists the
-- notable lanes by year and before the next harvest runs.
DELETE FROM lane_state WHERE source = 'openalex-notable';
