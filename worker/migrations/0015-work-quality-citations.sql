-- Enrichment can change citations after the nightly scoring pass.
CREATE TRIGGER work_quality_citations_changed AFTER UPDATE OF paper ON works
WHEN (NEW.paper ->> 'citationCount') >= 5
BEGIN
  DELETE FROM work_quality WHERE work_id = NEW.id;
END;

-- Check only works with existing scores when upgrading from migration 0014.
DELETE FROM work_quality
WHERE EXISTS (
  SELECT 1 FROM works
  WHERE works.id = work_quality.work_id AND (works.paper ->> 'citationCount') >= 5
);
