import type { Paper } from '../models/paper.ts';
import type { OrcidListedWork } from './orcid-service.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadline-harness.ts';
import { openAlexClient } from './open-alex-client.ts';
import { arrangeOrcidWorks, citedWorkIds, citedWorksState, extractOrcid, fetchWithTimeout, frequentCoauthors, getOrcidRecord, getOrcidWorks, loadOrcidPublications, ORCID_LISTED_WORKS_MAX, othersCitations, readerPapers } from './orcid-service.ts';

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

const IDENTIFIER = '0000-0002-1825-0097';
const NO_DECISIONS = { mine: [], notMine: [] };
// A synthetic OpenAlex work with what formatOpenAlexWorkAsPaper reads.
const openAlexWork = (id: number, doi: string | null, title: string, year = 2019) => ({
  id: `https://openalex.org/W${id}`, doi: doi ? `https://doi.org/${doi}` : null, title, display_name: title,
  type: 'article', publication_year: year, publication_date: `${year}-05-01`, authorships: [], primary_location: null,
});
type StubWork = ReturnType<typeof openAlexWork>;
const page = (results: StubWork[]) => Response.json({ meta: { count: results.length }, results });

/**
 * OpenAlex as the relay answers it: `attributed` for the works of the iD,
 * `byDoi` for a DOI lookup (only the DOIs asked for), `byId` for an id lookup,
 * and a 503 for the kinds of request in `down`. Returns each filter asked.
 */
function stubOpenAlex(t: TestContext, { attributed = [], byDoi = [], byId = [], down = [] }: { attributed?: StubWork[]; byDoi?: StubWork[]; byId?: StubWork[]; down?: string[] } = {}) {
  const asked: string[] = [];
  t.mock.method(openAlexClient, 'fetch', async (url: string | URL) => {
    const filter = new URL(url).searchParams.get('filter')!;
    asked.push(filter);
    const kind = filter.slice(0, filter.indexOf(':'));
    if (down.includes(kind)) return new Response('busy', { status: 503 });
    if (kind === 'author.orcid') return page(attributed);
    const values = filter.slice(filter.indexOf(':') + 1).split('|');
    if (kind === 'doi') return page(byDoi.filter(work => values.includes(work.doi!.replace('https://doi.org/', ''))));
    return page(byId.filter(work => values.includes(work.id.replace('https://openalex.org/', ''))));
  });
  return asked;
}

async function quietly<T>(run: () => Promise<T>) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = warn;
  }
}

const load = (decisions: { mine: string[]; notMine: string[] } = NO_DECISIONS, record: unknown = WORKS) => (
  withStubbedFetch(async () => Response.json(record), () => loadOrcidPublications(IDENTIFIER, 'orcid.org', Promise.resolve(decisions)))
);

test('a record work takes its paper from the works OpenAlex attributes to the iD, and only the others are looked up by DOI', async t => {
  const asked = stubOpenAlex(t, {
    // OpenAlex spells the article's DOI in capitals here; ORCID in lower case.
    attributed: [openAlexWork(1, '10.1000/ABC.1', 'An article'), openAlexWork(5, '10.5555/elsewhere', 'Attributed, not in the record')],
    byDoi: [openAlexWork(3, '10.1000/chapter.7', 'A chapter'), openAlexWork(9, '10.9999/other', 'Nobody asked for this')],
  });
  const loaded = await load();

  assert.deepEqual(asked, [`author.orcid:${IDENTIFIER}`, 'doi:10.1000/chapter.7']);
  assert.equal(loaded.details, 'complete');
  assert.equal(loaded.totalWorks, 4);
  assert.deepEqual(loaded.publications.map(({ work, paper }) => [work.putCode, paper?.title ?? null]), [
    ['21', null], ['12', 'An article'], ['31', 'A chapter'], ['41', null],
  ]);
});

test('a DOI lookup that fails keeps the papers that came, and says details are missing', async t => {
  stubOpenAlex(t, { attributed: [openAlexWork(1, '10.1000/abc.1', 'An article')], down: ['doi'] });
  const loaded = await quietly(() => load());
  assert.equal(loaded.details, 'failed');
  assert.deepEqual(loaded.publications.map(({ paper }) => paper?.title ?? null), [null, 'An article', null, null]);
});

test('when OpenAlex does not answer at all, every work of the record is still listed', async t => {
  stubOpenAlex(t, { down: ['author.orcid', 'doi'] });
  const loaded = await quietly(() => load());
  assert.equal(loaded.details, 'failed');
  assert.equal(loaded.attributed.failed, true);
  assert.deepEqual(loaded.publications.map(({ work, paper }) => [work.putCode, paper]), [['21', null], ['12', null], ['31', null], ['41', null]]);
});

test('a record with more works than the page lists shows the newest, and every one still keeps its work out of the suggestions', async t => {
  const group = (index: number) => ({
    'external-ids': { 'external-id': [id('doi', `10.1000/w${index}`)] },
    'work-summary': [summary(index, { title: { title: { value: `Work ${index}` } }, 'publication-date': { year: { value: String(1700 + index) } } })],
  });
  const total = ORCID_LISTED_WORKS_MAX + 5;
  // The oldest work, past the end of the list, is also attributed to the iD: it is not suggested.
  stubOpenAlex(t, { attributed: [openAlexWork(1, '10.1000/w0', 'Work 0', 1700)] });
  const loaded = await load(NO_DECISIONS, { group: Array.from({ length: total }, (_, index) => group(index)) });
  assert.equal(loaded.totalWorks, total);
  assert.equal(loaded.publications.length, ORCID_LISTED_WORKS_MAX);
  assert.equal(loaded.publications[0].work.title, `Work ${total - 1}`);
  assert.deepEqual(arrangeOrcidWorks(loaded, NO_DECISIONS).candidates, []);
});

test('the works attributed to the iD that the record does not list are candidates, each once, with the decision made about it', async t => {
  const recordWithOpenAlexId = {
    group: [...WORKS.group, {
      'external-ids': { 'external-id': [id('openalex', 'https://openalex.org/W40')] },
      'work-summary': [summary(51, { title: { title: { value: 'Listed by its OpenAlex id' } }, 'publication-date': { year: { value: '2018' } } })],
    }],
  };
  stubOpenAlex(t, {
    attributed: [
      openAlexWork(60, '10.2000/new', 'Newest suggestion', 2024),
      openAlexWork(1, '10.1000/abc.1', 'In the record by its DOI'),
      openAlexWork(40, null, 'In the record by its OpenAlex id'),
      openAlexWork(61, '10.2000/NEW', 'The same DOI twice', 2024),
      openAlexWork(62, null, 'Not mine', 2022),
      openAlexWork(63, '10.2000/added', 'Added by the reader', 2020),
      openAlexWork(64, null, 'Undecided', 2016),
    ],
  });
  const decisions = { mine: ['doi:10.2000/added'], notMine: ['openalex:W62'] };
  const loaded = await load(decisions, recordWithOpenAlexId);
  const { candidates, publications } = arrangeOrcidWorks(loaded, decisions);
  assert.deepEqual(candidates.map(({ key, paper, decision }) => [key, paper.title, decision]), [
    ['doi:10.2000/new', 'Newest suggestion', null],
    ['openalex:W62', 'Not mine', 'notMine'],
    ['doi:10.2000/added', 'Added by the reader', 'mine'],
    ['openalex:W64', 'Undecided', null],
  ]);
  // The added work joins the record's works by year.
  assert.deepEqual(publications.map(item => (item.kind === 'record' ? item.work.title : `added: ${item.paper?.title}`)), [
    'A preprint', 'added: Added by the reader', 'An article, as the author listed it', 'Listed by its OpenAlex id', 'A chapter', 'An undated talk',
  ]);
});

test('a work the reader added that OpenAlex no longer attributes is found by its identifier, or kept by it when it cannot be', async t => {
  const asked = stubOpenAlex(t, {
    byDoi: [openAlexWork(70, '10.3000/kept', 'Found by its DOI', 2021)],
    byId: [openAlexWork(71, null, 'Found by its OpenAlex id', 2020)],
  });
  // An added work that the record now lists stays a record work, once.
  const decisions = { mine: ['doi:10.3000/kept', 'openalex:W71', 'openalex:W72', 'doi:10.1000/abc.1'], notMine: [] };
  const loaded = await load(decisions);
  assert.ok(asked.includes('doi:10.1000/abc.1|10.1000/chapter.7|10.3000/kept'), asked.join(' '));
  assert.ok(asked.includes('openalex:W71|W72'), asked.join(' '));
  const { publications } = arrangeOrcidWorks(loaded, decisions);
  assert.deepEqual(publications.filter(item => item.kind === 'added').map(item => [item.key, item.paper?.title ?? null]), [
    ['doi:10.3000/kept', 'Found by its DOI'], ['openalex:W71', 'Found by its OpenAlex id'], ['openalex:W72', null],
  ]);
  assert.equal(publications.length, 7);
});

test('a record work matches OpenAlex by any DOI its versions list and by its arXiv id, so it is never also suggested', async t => {
  const recordWithTwoDois = {
    group: [...WORKS.group, {
      'external-ids': { 'external-id': [id('doi', '10.48550/arXiv.2203.00002'), id('doi', '10.1000/journal.1')] },
      'work-summary': [summary(61, {
        title: { title: { value: 'Preprint, then journal' } }, 'publication-date': { year: { value: '2022' } },
        'external-ids': { 'external-id': [id('doi', '10.48550/arXiv.2203.00002')] },
      })],
    }],
  };
  stubOpenAlex(t, {
    attributed: [
      // The journal version of the work above, which ORCID lists under the preprint's DOI first.
      openAlexWork(80, '10.1000/journal.1', 'The journal version', 2022),
      // The record's preprint known only by its arXiv id (2101.00001), under arXiv's DOI here.
      openAlexWork(81, '10.48550/arXiv.2101.00001', 'The preprint at OpenAlex', 2021),
    ],
  });
  const loaded = await load(NO_DECISIONS, recordWithTwoDois);
  const { candidates, publications } = arrangeOrcidWorks(loaded, NO_DECISIONS);
  assert.deepEqual(candidates, []);
  assert.deepEqual(publications.map(item => (item.kind === 'record' ? [item.work.title, item.paper?.title ?? null] : ['added', item.key])), [
    ['Preprint, then journal', 'The journal version'],
    ['A preprint', 'The preprint at OpenAlex'],
    ['An article, as the author listed it', null],
    ['A chapter', null],
    ['An undated talk', null],
  ]);
});

test('two works OpenAlex keeps for one arXiv paper stay two suggestions, each with its own decision', async t => {
  const withArxiv = (work: StubWork, arxiv: string) => ({ ...work, ids: { arxiv: `https://arxiv.org/abs/${arxiv}` } }) as StubWork;
  stubOpenAlex(t, {
    attributed: [
      withArxiv(openAlexWork(200, '10.7000/journal.9', 'Journal twin', 2023), '2305.00009'),
      openAlexWork(201, '10.48550/arXiv.2305.00009', 'Preprint twin', 2022),
    ],
  });
  const decisions = { mine: ['doi:10.48550/arxiv.2305.00009'], notMine: [] };
  const loaded = await load(decisions);
  const { candidates, publications } = arrangeOrcidWorks(loaded, decisions);
  assert.deepEqual(candidates.map(({ key, paper, decision }) => [key, paper.title, decision]), [
    ['doi:10.7000/journal.9', 'Journal twin', null],
    ['doi:10.48550/arxiv.2305.00009', 'Preprint twin', 'mine'],
  ]);
  assert.deepEqual(publications.filter(item => item.kind === 'added').map(item => [item.key, item.paper?.title ?? null]), [
    ['doi:10.48550/arxiv.2305.00009', 'Preprint twin'],
  ]);
});

test('a sandbox record is not matched against OpenAlex, which knows production iDs only', async t => {
  const asked = stubOpenAlex(t, { attributed: [openAlexWork(90, '10.2000/stranger', 'Someone else', 2024)] });
  const loaded = await withStubbedFetch(async () => Response.json(WORKS), () => loadOrcidPublications(IDENTIFIER, 'sandbox.orcid.org', Promise.resolve(NO_DECISIONS)));
  assert.ok(!asked.some(filter => filter.startsWith('author.orcid:')), asked.join(' '));
  assert.deepEqual(arrangeOrcidWorks(loaded, NO_DECISIONS).candidates, []);
  assert.equal(loaded.publications.length, 4);
});

test('when the decisions cannot be read the load fails, so nothing already decided is suggested again', async t => {
  stubOpenAlex(t);
  await assert.rejects(withStubbedFetch(async () => Response.json(WORKS), () => (
    loadOrcidPublications(IDENTIFIER, 'orcid.org', Promise.reject(new Error('offline')))
  )), /offline/);
});

// Synthetic papers as formatOpenAlexWorkAsPaper makes them: a short work id
// and authors with their OpenAlex author address.
const listedPaper = (id: number, year: number, authors: Array<[number, string]> = [], doi: string | null = null) => ({
  id: `W${id}`, title: `Work ${id}`, year, doi,
  authors: authors.map(([author, name]) => ({ id: `https://openalex.org/A${author}`, name })),
}) as Paper;
const recordRow = (paper: Paper | null): OrcidListedWork => ({
  kind: 'record', paper, work: { putCode: null, title: paper?.title ?? null, year: paper?.year ?? null, type: null, doi: null, externalIds: [] },
});

test('the works citations are asked for are the reader\'s papers, newest first, never one marked not theirs, at most 50', () => {
  const rows: OrcidListedWork[] = [
    recordRow(listedPaper(1, 2025)),
    recordRow(null),
    { kind: 'added', key: 'openalex:W2', paper: listedPaper(2, 2024) },
    recordRow(listedPaper(3, 2023, [], '10.1000/not-mine')),
    recordRow(listedPaper(1, 2025)),
    ...Array.from({ length: 60 }, (_, index) => recordRow(listedPaper(100 + index, 2020))),
  ];
  const papers = readerPapers(rows, { mine: ['openalex:W2'], notMine: ['doi:10.1000/not-mine'] });
  assert.deepEqual(papers.slice(0, 3).map(paper => paper.id), ['W1', 'W2', 'W100']);
  assert.equal(papers.length, 62);
  const ids = citedWorkIds(papers);
  assert.equal(ids.length, 50);
  assert.deepEqual(ids.slice(0, 3), ['W1', 'W2', 'W100']);
  assert.ok(!ids.includes('W3'));
});

test('a citing paper by the reader, or that is one of their works, is left out, and each other one names the works it cites', () => {
  const citing = (id: number, references: string[], orcids: string[] = []) => ({ paper: listedPaper(id, 2026), references, orcids });
  const result = othersCitations([
    citing(501, ['W9', 'W2', 'W1', 'W2']),
    citing(502, ['W1'], ['0000-0002-1825-0097']),
    citing(2, ['W1']),
    citing(503, ['W3'], ['0000-0001-5109-3700']),
  ], '0000-0002-1825-0097', ['W1', 'W2', 'W3']);
  assert.deepEqual(result.map(({ paper, cites }) => [paper.id, cites]), [['W501', ['W2', 'W1']], ['W503', ['W3']]]);
});

test('frequent coauthors share two works or more, leave out the reader and large collaborations, and are ordered and capped', () => {
  const crowd = Array.from({ length: 31 }, (_, index): [number, string] => [900 + index, `Member ${index}`]);
  const papers = [
    listedPaper(1, 2025, [[1, 'Ada Reader'], [2, 'Bea Close'], [3, 'Cy Twice'], [4, 'Dee Once'], [7, 'Rowan Vale']]),
    listedPaper(2, 2024, [[5, 'Ada Reader'], [2, 'Bea Close'], [3, 'Cy Twice'], [7, 'Rowan Vale']]),
    listedPaper(3, 2022, [[2, 'Bea Close'], [6, 'Eve Older'], [8, 'Al Older']]),
    listedPaper(4, 2021, [[6, 'Eve Older'], [8, 'Al Older'], [1, 'Ada Reader']]),
    listedPaper(5, 2020, crowd),
    listedPaper(6, 2019, crowd),
    ...Array.from({ length: 10 }, (_, index) => listedPaper(10 + index, 2010, [[300 + index, `Pair ${index}`], [400, 'Zed Many']])),
    ...Array.from({ length: 10 }, (_, index) => listedPaper(20 + index, 2010, [[300 + index, `Pair ${index}`]])),
  ];
  const result = frequentCoauthors(papers, { readerAuthorIds: ['https://openalex.org/A1', 'A5'], readerName: 'Rowan Vale' });
  assert.deepEqual(result.map(({ id, name, sharedWorks }) => [id, name, sharedWorks]), [
    ['A400', 'Zed Many', 10],
    ['A2', 'Bea Close', 3],
    ['A3', 'Cy Twice', 2],
    ['A8', 'Al Older', 2],
    ['A6', 'Eve Older', 2],
    ['A300', 'Pair 0', 2],
    ['A301', 'Pair 1', 2],
    ['A302', 'Pair 2', 2],
  ]);
  // With fewer than eight who share two, one who shares a single work still stays out.
  assert.deepEqual(frequentCoauthors(papers.slice(0, 4), { readerAuthorIds: ['A1', 'A5'] }).map(coauthor => coauthor.id), ['A2', 'A3', 'A7', 'A8', 'A6']);
});

test('with no author id of the reader known, only their full name or a place on every paper leaves an author out', () => {
  const ids = (papers: Paper[], readerName: string | null) => frequentCoauthors(papers, { readerAuthorIds: [], readerName }).map(coauthor => coauthor.id);
  // OpenAlex files the reader under two ids; the name matches whole, across
  // case and accents, and a coauthor written with an initial stays.
  const split = [
    listedPaper(1, 2025, [[1, 'María García'], [2, 'M. Garcia'], [3, 'Tess Often']]),
    listedPaper(2, 2024, [[1, 'María García'], [2, 'M. Garcia'], [3, 'Tess Often']]),
    listedPaper(3, 2023, [[11, 'Maria Garcia'], [3, 'Tess Often']]),
  ];
  assert.deepEqual(ids(split, 'maria GARCIA'), ['A2']);
  // With the reader's ids known, a coauthor on every paper stays.
  assert.deepEqual(frequentCoauthors(split, { readerAuthorIds: ['A1', 'A11'] }).map(coauthor => coauthor.id), ['A3', 'A2']);
  // A private or differently spelled name: whoever is on every paper is the reader.
  const one = [
    listedPaper(1, 2025, [[1, 'María García'], [2, 'M. Garcia'], [3, 'Tess Often']]),
    listedPaper(2, 2024, [[1, 'María García'], [2, 'M. Garcia']]),
    listedPaper(3, 2023, [[1, 'María García'], [3, 'Tess Often']]),
  ];
  assert.deepEqual(ids(one, null), ['A2', 'A3']);
  assert.deepEqual(ids(one, 'Maria G. Garcia'), ['A2', 'A3']);
});

test('the citations section tells works OpenAlex does not know from works whose details did not load', () => {
  const known = [listedPaper(1, 2025)];
  const unidentified = [{ ...listedPaper(2, 2024), id: 'doi:10.1000/x' }];
  assert.equal(citedWorksState(known, true), 'known');
  assert.equal(citedWorksState(unidentified, true), 'failed');
  assert.equal(citedWorksState([], true), 'failed');
  assert.equal(citedWorksState(unidentified, false), 'unknown');
  assert.equal(citedWorksState([], false), 'unknown');
});
