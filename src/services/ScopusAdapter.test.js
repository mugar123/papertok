import test from 'node:test';
import assert from 'node:assert/strict';

import { ScopusAdapter } from './adapters/ScopusAdapter.js';

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

  assert.equal(paper.id, 'scopus:2-s2.0-123');
  assert.equal(paper.doi, '10.1016/test.2026.1');
  assert.equal(paper.abstract, 'Useful abstract');
  assert.equal(paper.citationsCount, 42);
  assert.equal(paper.citationCountKnown, true);
  assert.equal(paper.primaryCategory, 'mech.robotics');
  assert.equal(paper.openAccess, true);
});

test('does not expose an unlinked Scopus citation count', () => {
  const paper = new ScopusAdapter().mapToStandard({
    eid: '2-s2.0-456',
    'dc:title': 'A result without attribution link',
    'citedby-count': '99',
  });
  assert.equal(paper.citationsCount, 0);
  assert.equal(paper.citationCountKnown, false);
});

