import type { TestContext } from 'node:test';
import type { Paper } from '../models/paper.ts';

import assert from 'node:assert/strict';
import test from 'node:test';
import { arxivPaper } from './arxiv-records.ts';
import { encodePaperKey, parsePaperKey } from '../utils/public-navigation.ts';
import { openAlexClient } from './open-alex-client.ts';
import { fetchOpenReviewPaper, loadArxivPaper, loadPaperByIdentity } from './paper-lookup.ts';

// PAP-88: the public paper page opens a DOI as one OpenAlex work, which is
// free and never refused by the Worker's budget. It used to ask for a works
// list filtered by DOI: billed, refused once the day passes the enrichment
// share, and a provider failure there read as "not found".

// Synthetic, shaped like an OpenAlex work.
const WORK = {
  id: 'https://openalex.org/W2741809807',
  doi: 'https://doi.org/10.7717/peerj.4375',
  title: 'The state of OA',
  publication_date: '2018-02-13',
  authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Heather Piwowar' }, institutions: [] }],
  abstract_inverted_index: { Open: [0], access: [1] },
  primary_location: { landing_page_url: 'https://peerj.com/articles/4375', source: { display_name: 'PeerJ', type: 'journal' } },
  concepts: [],
};

const doiKey = (doi: string) => parsePaperKey(encodePaperKey('doi', doi)!)!;

test('a paper opened by DOI is one request for the work by DOI: found, not found, or a failure the page can retry', async t => {
  const realFetch = openAlexClient.fetchImpl;
  const realBase = openAlexClient.apiBase;
  t.after(() => {
    openAlexClient.fetchImpl = realFetch;
    openAlexClient.apiBase = realBase;
  });
  openAlexClient.apiBase = 'https://api.papertok.app';
  const urls: URL[] = [];
  const answering = (response: () => Response) => {
    urls.length = 0;
    openAlexClient.clearMemoryCache();
    openAlexClient.fetchImpl = async input => {
      urls.push(new URL(String(input)));
      return response();
    };
  };

  answering(() => Response.json(WORK));
  const paper = await loadPaperByIdentity(doiKey('10.7717/peerj.4375'));
  assert.deepEqual(urls.map(url => `${url.origin}${url.pathname}`), ['https://api.papertok.app/openalex/works/doi:10.7717/peerj.4375']);
  assert.equal(urls[0].searchParams.has('filter'), false);
  assert.equal(paper?.title, 'The state of OA');
  assert.equal(paper?.doi, '10.7717/peerj.4375');

  answering(() => Response.json({ error: 'Not found' }, { status: 404 }));
  assert.equal(await loadPaperByIdentity(doiKey('10.1000/missing')), null);
  assert.equal(urls.length, 1);

  answering(() => Response.json({ error: 'Service unavailable' }, { status: 503 }));
  await assert.rejects(loadPaperByIdentity(doiKey('10.1000/down')), (error: { status?: number }) => error.status === 503);
  assert.equal(urls.length, 1, 'asked once');
});

test('an OpenReview key is never asked of OpenAlex or arXiv', async t => {
  const realFetch = openAlexClient.fetchImpl;
  t.after(() => { openAlexClient.fetchImpl = realFetch; });
  const asked: string[] = [];
  openAlexClient.fetchImpl = async url => { asked.push(String(url)); return new Response('{}'); };
  // `node --test` has no Worker origin configured, so the Worker request is
  // refused before it leaves; what this pins is who was asked.
  await assert.rejects(
    loadPaperByIdentity(parsePaperKey(encodePaperKey('openreview', '5pShDP8LSm')!)!),
    { code: 'WORKER_ORIGIN_NOT_ALLOWED' },
  );
  assert.deepEqual(asked, []);
});

// Synthetic, shaped like the `{ notes }` the Worker's `/sources/openreview` answers.
test('a paper opened by OpenReview id is one request to the Worker: found, not found, or a failure the page can retry', async () => {
  const asked: string[] = [];
  const through = (response: () => Response) => ({
    apiBase: 'https://api.papertok.app',
    fetchImpl: (async (url: RequestInfo | URL) => { asked.push(String(url)); return response(); }) as typeof fetch,
  });
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const paper = await fetchOpenReviewPaper('5pShDP8LSm', through(() => jsonResponse({
    notes: [{
      id: '5pShDP8LSm',
      forum: '5pShDP8LSm',
      content: { title: { value: 'Position: AI Development Should Prioritize Cognitive Security' }, authors: { value: ['Batu El'] } },
    }],
  })));
  assert.deepEqual(asked, ['https://api.papertok.app/sources/openreview?id=5pShDP8LSm']);
  assert.equal(paper?.id, 'openreview:5pShDP8LSm');
  assert.equal(encodePaperKey(paper), encodePaperKey('openreview', '5pShDP8LSm'), 'the paper is the one the key names');

  assert.equal(await fetchOpenReviewPaper('missingNote1', through(() => jsonResponse({ notes: [], count: 0 }))), null);

  await assert.rejects(
    fetchOpenReviewPaper('5pShDP8LSm', through(() => jsonResponse({ code: 'UPSTREAM_FAILED', upstreamStatus: 403 }, 502))),
    (error: Error & { status?: number }) => error.status === 502,
  );
});

// ENG-217: a shared arXiv paper waited for arXiv's whole deadline before
// OpenAlex was asked. Synthetic records, shaped like arXiv's and OpenAlex's;
// each test uses its own id because the enrichment cache outlives a test.
const arxivRecord = (arxivId: string) => arxivPaper({
  arxivId,
  title: 'Attention Is All You Need',
  abstract: 'The dominant sequence transduction models are based on recurrent networks.',
  authors: ['Ashish Vaswani'],
  doi: '',
  journalRef: '',
  comment: '',
  published: '2017-06-12T17:57:34Z',
  allCategories: ['cs.CL', 'cs.LG'],
  primaryCategory: 'cs.CL',
});
const arxivWork = (arxivId: string) => ({
  id: 'https://openalex.org/W2963403868',
  title: 'Attention Is All You Need',
  publication_date: '2017-06-12',
  cited_by_count: 1234,
  authorships: [{ author: { id: 'https://openalex.org/A2', display_name: 'Ashish Vaswani' }, institutions: [] }],
  abstract_inverted_index: { The: [0], dominant: [1], models: [2] },
  primary_location: { landing_page_url: `https://arxiv.org/abs/${arxivId}`, source: null },
  locations: [{ landing_page_url: `https://arxiv.org/abs/${arxivId}`, source: null }],
  primary_topic: { id: 'https://openalex.org/T10181', display_name: 'Natural Language Processing Techniques', score: 0.99 },
  topics: [{ id: 'https://openalex.org/T10181', display_name: 'Natural Language Processing Techniques', score: 0.99 }],
  concepts: [],
});

const arxivAfter = (ms: number, answer: () => Paper[]) => () => new Promise<Paper[]>((resolve, reject) => {
  setTimeout(() => { try { resolve(answer()); } catch (error) { reject(error); } }, ms);
});

// The requests OpenAlex receives through the shared client.
function openAlexAnswering(t: TestContext, work: unknown) {
  const realFetch = openAlexClient.fetchImpl;
  const realBase = openAlexClient.apiBase;
  t.after(() => {
    openAlexClient.fetchImpl = realFetch;
    openAlexClient.apiBase = realBase;
  });
  openAlexClient.apiBase = 'https://api.papertok.app';
  openAlexClient.clearMemoryCache();
  const asked: URL[] = [];
  openAlexClient.fetchImpl = async input => {
    asked.push(new URL(String(input)));
    return Response.json({ results: work ? [work] : [] });
  };
  return asked;
}

const pageWaitMs = 150;

test('a slow arXiv no longer holds a shared page: OpenAlex, asked beside it, supplies the paper', async t => {
  const asked = openAlexAnswering(t, arxivWork('1706.03762'));
  const started = Date.now();
  const paper = await loadArxivPaper('1706.03762', { pageWaitMs, fetchArxiv: arxivAfter(2_000, () => [arxivRecord('1706.03762')]) });
  assert.ok(Date.now() - started < 1_000, 'shown before arXiv answered');
  assert.equal(asked.length, 1, 'one OpenAlex request');
  assert.equal(paper?.title, 'Attention Is All You Need');
  assert.equal(paper?.pdfUrl, 'https://arxiv.org/pdf/1706.03762');
});

test('an arXiv answer that arrives while the page still waits keeps its categories, enriched by the same OpenAlex request', async t => {
  const asked = openAlexAnswering(t, arxivWork('1810.04805'));
  const paper = await loadArxivPaper('1810.04805', { pageWaitMs, fetchArxiv: arxivAfter(60, () => [arxivRecord('1810.04805')]) });
  assert.equal(asked.length, 1, 'one OpenAlex request');
  assert.equal(paper?.primaryCategory, 'cs.CL');
  assert.deepEqual(paper?.categories, ['cs.CL', 'cs.LG']);
  assert.equal(paper?.citationCount, 1234, 'OpenAlex enrichment merged');
});

test('a healthy arXiv is enriched by one OpenAlex lookup, and the next view of the paper asks OpenAlex nothing', async t => {
  const asked = openAlexAnswering(t, arxivWork('2005.14165'));
  const first = await loadArxivPaper('2005.14165', { pageWaitMs, fetchArxiv: async () => [arxivRecord('2005.14165')] });
  assert.equal(asked.length, 1);
  assert.match(asked[0].searchParams.get('filter') || '', /^locations\.landing_page_url:/);
  assert.equal(asked[0].searchParams.get('per_page'), '1', 'the same request as the fallback');
  assert.equal(first?.primaryCategory, 'cs.CL');
  assert.equal(first?.citationCount, 1234);

  asked.length = 0;
  openAlexClient.clearMemoryCache();
  const again = await loadArxivPaper('2005.14165', { pageWaitMs, fetchArxiv: async () => [arxivRecord('2005.14165')] });
  assert.deepEqual(asked, [], 'enrichment read from this browser');
  assert.equal(again?.citationCount, 1234);
});

test('a failed arXiv shows OpenAlex\'s paper from the one request already made', async t => {
  const asked = openAlexAnswering(t, arxivWork('1512.03385'));
  const paper = await loadArxivPaper('1512.03385', {
    pageWaitMs,
    fetchArxiv: async () => { throw Object.assign(new Error('Could not reach arXiv'), { status: 502 }); },
  });
  assert.equal(asked.length, 1);
  assert.equal(paper?.title, 'Attention Is All You Need');
  assert.equal(paper?.pdfUrl, 'https://arxiv.org/pdf/1512.03385');
});

test('when OpenAlex does not know the paper, a slow arXiv is waited for and nothing else is asked', async t => {
  const asked = openAlexAnswering(t, null);
  const paper = await loadArxivPaper('1409.0473', { pageWaitMs, fetchArxiv: arxivAfter(300, () => [arxivRecord('1409.0473')]) });
  assert.equal(asked.length, 1);
  assert.equal(paper?.primaryCategory, 'cs.CL');
});
