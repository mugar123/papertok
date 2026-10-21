import test from 'node:test';
import assert from 'node:assert/strict';

import { ScopusAdapter } from './adapters/ScopusAdapter.ts';

test('maps a Scopus result with attributed citations into a PaperTok paper', () => {
  const paper = new ScopusAdapter().mapToStandard({
    eid: '2-s2.0-123',
    'dc:title': 'A robotics result',
    'dc:description': '<p>Useful abstract</p>',
    'dc:creator': 'Ada Researcher',
    'prism:doi': '10.1016/TEST.2026.1',
    'prism:coverDate': '2026-04-03',
    'prism:publicationName': 'Engineering Journal',
    'citedby-count': '42',
    openaccess: '1',
    link: [
      { '@ref': 'scopus', '@href': 'https://www.scopus.com/record/123' },
      { '@ref': 'scopus-citedby', '@href': 'https://www.scopus.com/citedby/123' },
    ],
  }, ['mech.robotics']);

  assert.equal(paper!.id, 'scopus:2-s2.0-123');
  assert.equal(paper!.doi, '10.1016/test.2026.1');
  assert.equal(paper!.abstract, 'Useful abstract');
  // PaperCard reads `citationCount`; a paper that only carried `citationsCount`
  // rendered the count as undefined unless a caller happened to deduplicate it.
  assert.equal(paper!.citationCount, 42);
  assert.equal(paper!.scopusCitationCount, 42);
  assert.equal(paper!.citationCountKnown, true);
  assert.equal(paper!.openAccess, true);
  assert.equal(paper!.journal, 'Engineering Journal');
  assert.equal(paper!.published, '2026-04-03');
  assert.equal(paper!.sources.primary, 'scopus');
  assert.equal(paper!.scopusCitedByUrl, 'https://www.scopus.com/citedby/123');
  // The full Scopus record must not ride along into the feed or a saved list.
  assert.equal(paper!.raw, undefined);
});

// The search view names no subject area, so a Scopus record has no category of
// its own. The fallback to the first requested category made "Ecology of
// tropical forests" a Genetics paper for a reader of Genetics and Ecology
// (PAP-60, synthetic: Scopus was never queried).
test('a Scopus record takes no category from the request that found it', () => {
  const entry = { eid: '2-s2.0-1', 'dc:title': 'Ecology of tropical forests', 'dc:description': 'We survey canopy species.' };
  for (const requested of [['bio.gen', 'bio.eco'], ['bio.eco', 'bio.gen'], ['bio.gen']]) {
    const paper = new ScopusAdapter().mapToStandard(entry, requested)!;
    assert.equal(paper.primaryCategory, '', requested.join(', '));
    assert.deepEqual(paper.categories, [], requested.join(', '));
    assert.deepEqual(new Set(paper._fetchedFor), new Set(requested), requested.join(', '));
  }
});

test('does not expose an unlinked Scopus citation count', () => {
  const paper = new ScopusAdapter().mapToStandard({
    eid: '2-s2.0-456',
    'dc:title': 'A result without attribution link',
    'citedby-count': '99',
  });
  assert.equal(paper!.citationCount, 0);
  assert.equal(paper!.citationCountKnown, false);
  assert.equal(paper!.scopusCitationCount, undefined);
});

test('falls back to the shared placeholder when the Scopus view carries no abstract', () => {
  const paper = new ScopusAdapter().mapToStandard({
    eid: '2-s2.0-789',
    'dc:title': 'A STANDARD view result',
    'prism:publicationName': 'Journal of Missing Abstracts',
  });
  assert.equal(paper!.abstract, 'No abstract available.');
});

