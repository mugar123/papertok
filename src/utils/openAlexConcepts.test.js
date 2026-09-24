import test from 'node:test';
import assert from 'node:assert/strict';
import { usableOpenAlexConcepts } from './openAlexConcepts.js';
import { mapOpenAlexEnrichmentWork } from '../services/openAlexService.js';

// "MEDLINE" on a PubMed card was OpenAlex concept C2779473830, merged by the
// enrichment with no score threshold: it sits on 27% of August works and 47%
// of the editorials (audit 2026-09-23, issue 7). The adapter already kept
// only concepts scored above 0.3; the enrichment and the Explorer did not.
const MEDLINE = { id: 'https://openalex.org/C2779473830', display_name: 'MEDLINE', score: 0.42 };
const CARDIOLOGY = { id: 'https://openalex.org/C164705383', display_name: 'Cardiology', score: 0.61 };
const WEAK = { id: 'https://openalex.org/C1', display_name: 'Volume (thermodynamics)', score: 0.12 };

test('a concept counts when it scores above 0.3 and is not a bibliographic database', () => {
  assert.deepEqual(usableOpenAlexConcepts([MEDLINE, CARDIOLOGY, WEAK]), [CARDIOLOGY]);
  assert.deepEqual(
    usableOpenAlexConcepts([{ display_name: 'PubMed', score: 0.9 }, { display_name: 'Web of science', score: 0.8 }, { display_name: 'Oncology' }]),
    [{ display_name: 'Oncology' }],
  );
  assert.deepEqual(usableOpenAlexConcepts(null), []);
});

test('the feed enrichment carries only those concepts', () => {
  const mapped = mapOpenAlexEnrichmentWork({
    id: 'https://openalex.org/W1',
    type: 'article',
    concepts: [MEDLINE, CARDIOLOGY, WEAK],
  });

  assert.deepEqual(mapped.enrichment.concepts, [CARDIOLOGY]);
});
