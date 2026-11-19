import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadline-harness.ts';
import { openAlexClient } from './open-alex-client.ts';
import { extractOrcid, fetchWithTimeout, getOrcidRecord, getOrcidWorks, loadOrcidPublications } from './orcid-service.ts';

test('extracts a clean ORCID from a bare id, a URL and a checksum ending in X', () => {
  assert.equal(extractOrcid('0000-0002-1825-0097'), '0000-0002-1825-0097');
  assert.equal(extractOrcid('https://orcid.org/0000-0002-1825-0097'), '0000-0002-1825-0097');
  assert.equal(extractOrcid('0000-0002-1825-009x'), '0000-0002-1825-009X');
  assert.equal(extractOrcid('not an orcid'), null);
  assert.equal(extractOrcid(''), null);
});

test('the deadline covers an ORCID body that never finishes', async () => {
  // This helper hands the response back unread — `getOrcidRecord` and its
  // siblings call `response.json()` further down. It used to clear its timer
  // before returning, in both the success and the failure path, so every one of
  // those reads ran with no deadline on it at all.
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout('https://pub.orcid.org/v3.0/0000-0002-1825-0097/record', {}, 50);
        await response.json();
      }),
      'TimeoutError',
    );
  });
});

test('a job ORCID gives no end year keeps its end unknown', async () => {
  const summary = (end?: string) => ({
    'employment-summary': {
      organization: { name: 'DataCite' },
      'start-date': { year: { value: '2015' } },
      ...(end ? { 'end-date': { year: { value: end } } } : {}),
    },
  });
  const payload = {
    'activities-summary': { employments: { 'affiliation-group': [{ summaries: [summary('2021')] }, { summaries: [summary()] }] } },
  };
  const record = await withStubbedFetch(async () => Response.json(payload), () => getOrcidRecord('0000-0003-1419-2405'));
  assert.deepEqual(record?.employments.map((job) => job.endDate), ['2021', undefined]);
});

// A synthetic answer in the shape of ORCID's public API v3.0 `/works`: two
// versions of one article grouped by their DOI, a preprint known by its arXiv
// id only, a chapter whose ISBN is the book's (`part-of`), and a work with no
// date.
const id = (type: string, value: string, relationship = 'self') => ({
  'external-id-type': type, 'external-id-value': value, 'external-id-relationship': relationship,
});
const summary = (putCode: number, fields: Record<string, unknown>) => ({ 'put-code': putCode, visibility: 'public', ...fields });
const WORKS = {
  group: [
    {
      'external-ids': { 'external-id': [id('doi', '10.1000/ABC.1'), id('pmid', '31234567')] },
      'work-summary': [
        summary(11, { title: { title: { value: 'An article, as the publisher listed it' } }, type: 'journal-article', 'publication-date': { year: { value: '2019' } }, 'external-ids': { 'external-id': [id('pmid', '31234567')] }, 'display-index': '0' }),
        summary(12, { title: { title: { value: '  An article,  as the author listed it ' } }, type: 'journal-article', 'publication-date': { year: { value: '2019' } }, 'external-ids': { 'external-id': [id('doi', 'https://doi.org/10.1000/abc.1')] }, 'display-index': '1' }),
      ],
    },
    {
      'external-ids': { 'external-id': [id('arxiv', '2101.00001')] },
      'work-summary': [summary(21, { title: { title: { value: 'A preprint' } }, type: 'preprint', 'publication-date': { year: { value: '2021' } }, 'external-ids': { 'external-id': [id('arxiv', '2101.00001')] } })],
    },
    {
      'external-ids': { 'external-id': [id('doi', '10.1000/chapter.7')] },
      'work-summary': [summary(31, { title: { title: { value: 'A chapter' } }, type: 'book-chapter', 'publication-date': { year: { value: '2015' } }, 'external-ids': { 'external-id': [id('doi', '10.1000/chapter.7'), id('isbn', '9780000000002', 'part-of')] } })],
    },
    {
      'work-summary': [summary(41, { title: { title: { value: 'An undated talk' } }, type: 'lecture-speech', 'publication-date': null })],
    },
  ],
};

test('lists one work per ORCID group, newest first, with what ORCID gives and nothing more', async () => {
  const asked: Array<{ url: string; accept: string | null }> = [];
  const works = await withStubbedFetch(async (input, init) => {
    asked.push({ url: String(input), accept: new Headers(init?.headers).get('accept') });
    return Response.json(WORKS);
  }, () => getOrcidWorks('0000-0002-1825-0097'));

  assert.deepEqual(asked, [{ url: 'https://pub.orcid.org/v3.0/0000-0002-1825-0097/works', accept: 'application/json' }]);
  assert.deepEqual(works, [
    { putCode: '21', title: 'A preprint', year: 2021, type: 'preprint', doi: null, externalIds: [{ type: 'arxiv', value: '2101.00001' }] },
    {
      putCode: '12', title: 'An article, as the author listed it', year: 2019, type: 'journal-article', doi: '10.1000/abc.1',
      externalIds: [{ type: 'doi', value: '10.1000/abc.1' }, { type: 'pmid', value: '31234567' }],
    },
    { putCode: '31', title: 'A chapter', year: 2015, type: 'book-chapter', doi: '10.1000/chapter.7', externalIds: [{ type: 'doi', value: '10.1000/chapter.7' }] },
    { putCode: '41', title: 'An undated talk', year: null, type: 'lecture-speech', doi: null, externalIds: [] },
  ]);
});

test('reads a sandbox record from the sandbox, and fails loudly when ORCID does not answer', async () => {
  const asked: string[] = [];
  await withStubbedFetch(async (input) => { asked.push(String(input)); return Response.json({ group: [] }); }, () => getOrcidWorks('0000-0002-1825-0097', 'sandbox.orcid.org'));
  assert.deepEqual(asked, ['https://pub.sandbox.orcid.org/v3.0/0000-0002-1825-0097/works']);

  await withStubbedFetch(async () => new Response('down', { status: 503 }), () => assert.rejects(getOrcidWorks('0000-0002-1825-0097')));
  await assert.rejects(getOrcidWorks('0000-0002-1825-0098'), /ORCID_INVALID_ID/);
});

const openAlexWork = (doi: string, title: string) => ({
  id: `https://openalex.org/W${doi.replace(/\D/g, '')}`, doi: `https://doi.org/${doi}`, title, display_name: title,
  type: 'article', publication_year: 2019, publication_date: '2019-05-01', authorships: [], primary_location: null,
});

test('a work OpenAlex knows by its DOI comes with its paper; the others keep only what ORCID gives', async t => {
  const asked: string[] = [];
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL) => {
    asked.push(new URL(url).searchParams.get('filter')!);
    // OpenAlex has the article, not the chapter, and an answer for a DOI nobody asked about is not attached.
    return Response.json({ meta: { count: 2 }, results: [openAlexWork('10.1000/abc.1', 'An article'), openAlexWork('10.9999/other', 'Another paper')] });
  });
  const { publications, details } = await withStubbedFetch(async () => Response.json(WORKS), () => loadOrcidPublications('0000-0002-1825-0097', 'orcid.org'));

  assert.deepEqual(asked, ['doi:10.1000/abc.1|10.1000/chapter.7']);
  assert.equal(details, 'complete');
  assert.deepEqual(publications.map(({ work, paper }) => [work.putCode, paper?.title ?? null]), [
    ['21', null], ['12', 'An article'], ['31', null], ['41', null],
  ]);
});

test('when OpenAlex does not answer, every work is still listed and the missing details are said', async t => {
  t.mock.method(openAlexClient, 'fetch', async () => new Response('busy', { status: 503 }));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { publications, details } = await withStubbedFetch(async () => Response.json(WORKS), () => loadOrcidPublications('0000-0002-1825-0097', 'orcid.org'));
    assert.equal(details, 'failed');
    assert.equal(publications.length, 4);
    assert.ok(publications.every(publication => publication.paper === null));
  } finally {
    console.warn = warn;
  }
});
