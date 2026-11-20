import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePaperKey, parsePaperKey } from '../utils/public-navigation.ts';
import { openAlexClient } from './open-alex-client.ts';
import { fetchOpenReviewPaper, loadPaperByIdentity } from './paper-lookup.ts';

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
