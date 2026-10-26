import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAdsNotable } from './physics-api.ts';

// Synthetic ADS answer in the shape of /v1/search/query; not a captured record.
const quantumDoc = {
  bibcode: '2018PhRvL.120c0501X',
  title: ['A quantum result'],
  author: ['Doe, J.'],
  arxiv_class: ['quant-ph'],
  citation_count: 900,
  year: '2018',
  identifier: ['arXiv:1801.00001', '10.1103/PhysRevLett.120.030501'],
  doctype: 'article',
};

test("an arXiv class's notable listing asks ADS for the year's most-cited papers of that class", async t => {
  const urls: URL[] = [];
  const authorizations: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ response: { docs: [quantumDoc] } });
  });
  const { docs } = await fetchAdsNotable({ NASA_ADS_API_TOKEN: 'ads-test-token' }, 'quant-ph', 2018, 100);
  assert.equal(`${urls[0].origin}${urls[0].pathname}`, 'https://api.adsabs.harvard.edu/v1/search/query');
  assert.equal(urls[0].searchParams.get('q'), 'arxiv_class:"quant-ph" year:2018');
  assert.equal(urls[0].searchParams.get('sort'), 'citation_count desc');
  assert.equal(urls[0].searchParams.get('rows'), '100');
  assert.equal(urls[0].searchParams.get('start'), '0');
  assert.ok(urls[0].searchParams.get('fl')!.split(',').includes('citation_count'));
  assert.equal(authorizations[0], 'Bearer ads-test-token');
  assert.deepEqual(docs.map(doc => [doc.bibcode, doc.citation_count, doc.arxiv_class]), [['2018PhRvL.120c0501X', 900, ['quant-ph']]]);
});

test('ADS refusing a notable listing reaches the caller with its status', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Too many requests', { status: 429 }));
  await assert.rejects(
    fetchAdsNotable({ NASA_ADS_API_TOKEN: 'ads-test-token' }, 'cs.RO', 2019, 100),
    (error: Error & { status?: number }) => error.status === 429,
  );
});
