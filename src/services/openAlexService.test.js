import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCrossrefInstitutionWork } from './crossrefInstitutionService.js';

test('maps Crossref institution fallback records into PaperTok papers', () => {
  const paper = mapCrossrefInstitutionWork({
    DOI: '10.1000/example-work',
    title: ['A study from an institutional fallback'],
    abstract: '<jats:p>Crossref <i>abstract</i>.</jats:p>',
    author: [{ given: 'Ada', family: 'Lovelace' }],
    published: { 'date-parts': [[2024, 4, 2]] },
    'container-title': ['Journal of Reliable Metadata'],
    publisher: 'Example Publisher',
    URL: 'https://doi.org/10.1000/example-work',
    'is-referenced-by-count': 18,
    type: 'journal-article',
    license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }],
  });

  assert.deepEqual(paper, {
    id: 'crossref:10.1000/example-work',
    doi: '10.1000/example-work',
    title: 'A study from an institutional fallback',
    abstract: 'Crossref abstract .',
    authors: [{ name: 'Ada Lovelace' }],
    year: 2024,
    published: '2024-04-02',
    journal: 'Journal of Reliable Metadata',
    publisher: 'Example Publisher',
    publicationType: 'journal',
    publicationStatus: 'published',
    openAccess: true,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    landingPageUrl: 'https://doi.org/10.1000/example-work',
    citationCount: 18,
    sourceType: 'journal-article',
    provider: 'crossref',
    sources: { primary: 'crossref', enrichedBy: [] },
  });
});
