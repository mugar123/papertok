import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenAlexEnrichmentWork, mapOpenAlexWork } from './open-alex-work.ts';

// Synthetic works shaped as OpenAlex returns them. The source ids are real:
// American Economic Review is S23254222 (`/sources/issn:0002-8282`, 2026-10-25)
// and arXiv's repository S4306400194.
const work = (source: NonNullable<OpenAlexWork['primary_location']>['source']): OpenAlexWork => ({
  id: 'https://openalex.org/W7000000001',
  doi: 'https://doi.org/10.1257/aer.20260001',
  title: 'Monetary policy and the term structure',
  type: 'article',
  publication_date: '2026-10-01',
  publication_year: 2026,
  primary_location: { is_published: true, landing_page_url: 'https://doi.org/10.1257/aer.20260001', source },
});

test("a work keeps the OpenAlex id of the journal that published it, and no id when its source is not a journal", () => {
  const journal = work({ id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' });
  assert.equal(mapOpenAlexWork(journal)?.venueId, 'S23254222');
  assert.equal(mapOpenAlexEnrichmentWork(journal)?.enrichment.venueId, 'S23254222');

  const repository = work({ id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' });
  assert.equal(mapOpenAlexWork(repository)?.venueId, undefined, 'a repository is not a venue to follow');
  assert.equal(mapOpenAlexEnrichmentWork(repository)?.enrichment.venueId, undefined);

  assert.equal(mapOpenAlexWork(work(null))?.venueId, undefined, 'no source, no venue');
  assert.equal(mapOpenAlexWork(work({ display_name: 'A journal without an id', type: 'journal' }))?.venueId, undefined);
});
