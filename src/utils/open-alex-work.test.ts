import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOpenAlexWorkAsPaper, mapOpenAlexEnrichmentWork, mapOpenAlexWork } from './open-alex-work.ts';
import { journalExplorerLink } from './explorer-paths.ts';
import { PaperBuilder } from '../services/paper-builder.ts';

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

test('a work without a landing page links to doi.org with every character of its DOI', () => {
  // OpenAlex writes the resolver before the DOI's characters unencoded (a
  // lookup on 2026-11-16); this real Wiley DOI ends in `#`. The work is synthetic.
  const doi = '10.1002/(sici)1097-0282(1996)40:1<1::aid-bip1>3.0.co;2-#';
  const paper = mapOpenAlexWork({ ...work(null), doi: `https://doi.org/${doi}`, primary_location: { source: null } });
  assert.equal(paper?.doi, doi);
  assert.equal(paper?.landingPageUrl, 'https://doi.org/10.1002/(sici)1097-0282(1996)40:1%3C1::aid-bip1%3E3.0.co;2-%23');
  // A DOI the encoder refuses keeps the link OpenAlex gave, as before.
  const subPrefix = 'https://doi.org/10.1000.10/123';
  assert.equal(mapOpenAlexWork({ ...work(null), doi: subPrefix, primary_location: { source: null } })?.landingPageUrl, subPrefix);
});

test("a work keeps the OpenAlex id of the journal that published it, and no id when its source is not a journal", () => {
  const journal = work({ id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' });
  assert.equal(mapOpenAlexWork(journal)?.venueId, 'S23254222');
  assert.equal(mapOpenAlexEnrichmentWork(journal)?.enrichment.venueId, 'S23254222');

  const repository = work({ id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' });
  assert.equal(mapOpenAlexWork(repository)?.venueId, undefined, 'a repository is not a venue to follow');
  assert.equal(mapOpenAlexEnrichmentWork(repository)?.enrichment.venueId, undefined);

  // OpenAlex types the IMF Working Paper series a journal; the Explorer makes no journal feed of it.
  const series = work({ id: 'https://openalex.org/S4210171147', display_name: 'IMF Working Paper', type: 'journal' });
  assert.equal(mapOpenAlexWork(series)?.venueId, undefined, 'a listed working-paper series is not a journal venue');

  assert.equal(mapOpenAlexWork(work(null))?.venueId, undefined, 'no source, no venue');
  assert.equal(mapOpenAlexWork(work({ display_name: 'A journal without an id', type: 'journal' }))?.venueId, undefined);
});

test('the same OpenAlex work links its journal\'s page through every normalizer', () => {
  const journal = work({ id: 'https://openalex.org/S23254222', display_name: 'American Economic Review', type: 'journal' });
  const expected = { name: 'American Economic Review', path: '/explorer/source/S23254222' };

  assert.deepEqual(journalExplorerLink(mapOpenAlexWork(journal)), expected);
  assert.deepEqual(journalExplorerLink(formatOpenAlexWorkAsPaper(journal)), expected);

  // A card from another source (arXiv, with its own journal reference) takes
  // the id and OpenAlex's name together from the enrichment.
  const arxiv = PaperBuilder.create({ id: '2610.00001', sources: { primary: 'arxiv', enrichedBy: [] }, title: 'Monetary policy', journal: 'Am. Econ. Rev. 116, 1 (2026)' });
  const enriched = PaperBuilder.merge(arxiv, mapOpenAlexEnrichmentWork(journal)!.enrichment, 'openalex');
  assert.deepEqual(journalExplorerLink(enriched), expected);

  // No id: a repository links no journal.
  const repository = work({ id: 'https://openalex.org/S4306400194', display_name: 'arXiv (Cornell University)', type: 'repository' });
  assert.equal(journalExplorerLink(formatOpenAlexWorkAsPaper(repository)), null);
  assert.equal(journalExplorerLink(mapOpenAlexWork(repository)), null);
});
