import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getInstitutionAuthorsFromCrossref,
  getInstitutionWorksFromCrossref,
  mapCrossrefInstitutionWork,
} from './crossrefInstitutionService.js';

test('builds a searchable institution author fallback from Crossref works', async () => {
  let requestedUrl = '';
  const request = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      message: {
        items: [
          {
            'is-referenced-by-count': 12,
            author: [
              { given: 'Ada', family: 'Lovelace', ORCID: 'https://orcid.org/0000-0001-0000-0001' },
              { given: 'Grace', family: 'Hopper' },
            ],
          },
          {
            'is-referenced-by-count': 8,
            author: [
              { given: 'Ada', family: 'Lovelace', ORCID: 'https://orcid.org/0000-0001-0000-0001' },
            ],
          },
        ],
      },
    }), { status: 200 });
  };

  const result = await getInstitutionAuthorsFromCrossref(
    'University of Salamanca',
    1,
    'Ada',
    request,
  );

  assert.match(requestedUrl, /query\.affiliation=University\+of\+Salamanca/);
  assert.match(requestedUrl, /query\.author=Ada/);
  assert.equal(result.source, 'crossref');
  assert.equal(result.authors.length, 1);
  assert.equal(result.authors[0].display_name, 'Ada Lovelace');
  assert.equal(result.authors[0].works_count, 2);
  assert.equal(result.authors[0].cited_by_count, 20);
});

test('does not pretend that the Crossref author fallback has further pages', async () => {
  const result = await getInstitutionAuthorsFromCrossref(
    'University of Salamanca',
    2,
    '',
    async () => {
      throw new Error('The second page should not request Crossref');
    },
  );

  assert.deepEqual(result, { authors: [], total: 0, source: 'crossref' });
});

test('the peer-review filter keeps a refereed Crossref work that is not a journal article', async () => {
  const request = async () => new Response(JSON.stringify({
    message: {
      items: [
        {
          DOI: '10.1000/proceedings',
          title: ['A refereed conference paper'],
          type: 'proceedings-article',
          'container-title': ['Proceedings of Reliable Metadata'],
        },
        {
          DOI: '10.1000/posted',
          title: ['A paper posted before review'],
          type: 'posted-content',
        },
      ],
    },
  }), { status: 200 });

  const { papers } = await getInstitutionWorksFromCrossref(
    'University of Salamanca',
    1,
    '',
    { peerReviewed: true },
    request,
  );

  assert.deepEqual(papers.map(paper => paper.id), ['crossref:10.1000/proceedings']);
  // The filter this replaced asked `publicationType !== 'journal'`, which drops
  // a refereed conference paper on the strength of its venue's shape.
  assert.notEqual(papers[0].publicationType, 'journal');
});

test('derives the canonical peerReviewed field from the Crossref work type', () => {
  const peerReviewedFor = (type) => mapCrossrefInstitutionWork({
    DOI: '10.1000/example',
    title: ['A work of some type'],
    type,
  }).peerReviewed;

  assert.equal(peerReviewedFor('journal-article'), true);
  assert.equal(peerReviewedFor('proceedings-article'), true);
  assert.equal(peerReviewedFor('posted-content'), false);
  assert.equal(peerReviewedFor('dataset'), false);
});

// Licence arrays as Crossref served them on 2026-09-23.
const SUBSCRIPTION_LICENCES = [
  { start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://www.elsevier.com/tdm/userlicense/1.0/' },
  { start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 }, 'content-version': 'stm-asf', 'delay-in-days': 0, URL: 'https://doi.org/10.15223/policy-017' },
];
const OPEN_AFTER_TDM_LICENCES = [
  { start: { 'date-parts': [[2026, 1, 1]], 'date-time': '2026-01-01T00:00:00Z', timestamp: 1767225600000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://www.elsevier.com/tdm/userlicense/1.0/' },
  { start: { 'date-parts': [[2026, 9, 10]], 'date-time': '2026-09-10T00:00:00Z', timestamp: 1788998400000 }, 'content-version': 'vor', 'delay-in-days': 252, URL: 'http://creativecommons.org/licenses/by/4.0/' },
];

test('a subscription article is not open access because its text-mining licence has a URL', () => {
  const paper = mapCrossrefInstitutionWork({
    DOI: '10.1016/j.jmb.2026.170030',
    title: ['A Journal of Molecular Biology article'],
    type: 'journal-article',
    license: SUBSCRIPTION_LICENCES,
  });

  // Unknown, not closed: Crossref has no open licence, which is not a paywall.
  assert.equal(paper.openAccess, undefined);
  assert.equal(paper.license, undefined);
});

test('an open version of record keeps its Creative Commons licence, not the one listed first', () => {
  const paper = mapCrossrefInstitutionWork({
    DOI: '10.1016/j.clinsp.2026.101156',
    title: ['A Clinics article'],
    type: 'journal-article',
    license: OPEN_AFTER_TDM_LICENCES,
  });

  assert.equal(paper.openAccess, true);
  assert.equal(paper.license, 'http://creativecommons.org/licenses/by/4.0/');
});

test('does not record a Crossref preprint as published', () => {
  const preprint = mapCrossrefInstitutionWork({
    DOI: '10.1000/posted',
    title: ['A paper posted before review'],
    type: 'posted-content',
  });

  assert.equal(preprint.publicationType, 'preprint');
  assert.equal(preprint.publicationStatus, 'preprint');
});
