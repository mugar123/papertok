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
  assert.equal(urls[0].searchParams.get('q'), 'arxiv_class:"quant-ph" year:2018 doctype:(article OR eprint OR inproceedings)');
  assert.equal(urls[0].searchParams.get('sort'), 'citation_count desc');
  assert.equal(urls[0].searchParams.get('rows'), '100');
  assert.equal(urls[0].searchParams.get('start'), '0');
  assert.ok(urls[0].searchParams.get('fl')!.split(',').includes('citation_count'));
  assert.equal(authorizations[0], 'Bearer ads-test-token');
  assert.deepEqual(docs.map(doc => [doc.bibcode, doc.citation_count, doc.arxiv_class]), [['2018PhRvL.120c0501X', 900, ['quant-ph']]]);
});

// Synthetic page of the classes of a year's most-cited nucl-th papers, most
// cited first, in the shape the classes-only search returns; not captured.
const ranking = [
  { bibcode: '2018ApJ...852L..29A', arxiv_class: ['astro-ph.HE', 'nucl-th'] },
  { bibcode: '2018PhRvC..97b4301B', arxiv_class: ['nucl-th', 'nucl-ex'] },
  { bibcode: '2018PhRvL.120g2701C', arxiv_class: ['hep-ph', 'nucl-th'] },
  { bibcode: '2018A&A...612A..10D', arxiv_class: ['nucl-th'] },
  { bibcode: '2018NuPhA.970..107E', arxiv_class: ['nucl-th', 'hep-ph'] },
];

test("an own-class notable listing keeps the year's most-cited papers arXiv files under the class first", async t => {
  const urls: URL[] = [];
  const authorizations: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    authorizations.push(new Headers(init?.headers).get('authorization'));
    if (url.searchParams.get('fl') === 'bibcode,arxiv_class') return Response.json({ response: { docs: ranking } });
    const asked = [...url.searchParams.get('q')!.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    return Response.json({ response: { docs: ranking.filter(doc => asked.includes(doc.bibcode)).map(doc => ({ ...doc, title: ['A nuclear result'] })) } });
  });
  const { docs } = await fetchAdsNotable({ NASA_ADS_API_TOKEN: 'ads-test-token' }, 'nucl-th', 2018, 2, true);
  assert.equal(urls[0].searchParams.get('q'), 'arxiv_class:"nucl-th" year:2018 doctype:(article OR eprint OR inproceedings)');
  assert.equal(urls[0].searchParams.get('fl'), 'bibcode,arxiv_class');
  assert.equal(urls[0].searchParams.get('rows'), '2000');
  assert.equal(urls[0].searchParams.get('sort'), 'citation_count desc');
  assert.equal(urls[1].searchParams.get('q'), 'bibcode:("2018PhRvC..97b4301B" OR "2018A&A...612A..10D") doctype:(article OR eprint OR inproceedings)');
  assert.equal(urls[1].searchParams.get('rows'), '2');
  assert.equal(urls[1].searchParams.get('sort'), 'citation_count desc');
  assert.ok(urls[1].searchParams.get('fl')!.split(',').includes('abstract'));
  assert.deepEqual(authorizations, ['Bearer ads-test-token', 'Bearer ads-test-token']);
  assert.deepEqual(docs.map(doc => doc.bibcode), ['2018PhRvC..97b4301B', '2018A&A...612A..10D']);
});

test('a year whose most-cited papers of the class were all cross-listed asks ADS once and lists none', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ response: { docs: [ranking[0], ranking[2]] } });
  });
  const { docs } = await fetchAdsNotable({ NASA_ADS_API_TOKEN: 'ads-test-token' }, 'nucl-th', 2018, 100, true);
  assert.equal(calls, 1);
  assert.deepEqual(docs, []);
});

test('ADS refusing a notable listing reaches the caller with its status', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Too many requests', { status: 429 }));
  await assert.rejects(
    fetchAdsNotable({ NASA_ADS_API_TOKEN: 'ads-test-token' }, 'cs.RO', 2019, 100),
    (error: Error & { status?: number }) => error.status === 429,
  );
});
