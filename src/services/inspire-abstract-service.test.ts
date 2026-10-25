import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInspireAbstracts } from './inspire-abstract-service.ts';
import { dribblingFetch, settleWithin } from '../test-support/deadline-harness.ts';

const hit = (doi: string, value: string) => ({ metadata: { dois: [{ value: doi }], abstracts: [{ value }] } });
const response = (hits: ReturnType<typeof hit>[]) => Response.json({ hits: { total: hits.length, hits } });

test('recovers the audited quantum strings paper by DOI and caches missing Springer records', async t => {
  // Reduced from INSPIRE 231728, retrieved on 2026-10-18. Text is a source excerpt.
  const abstract = 'The p -loop amplitude of closed oriented bosonic strings in 26 dimensions is considered.';
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).searchParams.get('q'),
      'doi:"10.1016/0370-2693(86)90963-9" OR doi:"10.1007/bf01135528" OR doi:"10.1007/bf01231766"');
    return response([hit('10.1016/0370-2693(86)90963-9', abstract)]);
  });
  const dois = ['https://doi.org/10.1016/0370-2693(86)90963-9', '10.1007/BF01135528', '10.1007/BF01231766'];
  const records = await fetchInspireAbstracts(dois);
  assert.deepEqual(records, [{ doi: '10.1016/0370-2693(86)90963-9', abstract, sources: { primary: 'inspire', enrichedBy: [] } }]);
  assert.deepEqual(await fetchInspireAbstracts(dois), records);
  assert.equal(fetch.mock.callCount(), 1);
});

test('unrelated DOIs and ambiguous duplicate records never supply an abstract', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response([
    hit('10.5555/other', 'Unrelated text.'),
    hit('10.5555/conflict', 'One text.'), hit('10.5555/conflict', 'Another text.'),
  ]));
  assert.deepEqual(await fetchInspireAbstracts(['10.5555/target', '10.5555/conflict']), []);
  fetch.mock.mockImplementation(async () => response([hit('10.5555/conflict', 'Confirmed text.')]));
  assert.equal((await fetchInspireAbstracts(['10.5555/conflict']))[0].abstract, 'Confirmed text.');
});

test('normalizes scientific markup and skips placeholders without fabricating abstracts', async t => {
  t.mock.method(globalThis, 'fetch', async () => response([
    hit('10.5555/markup', '<p>A &amp; B study <inline-formula><tex-math>$x^2$</tex-math></inline-formula>.</p>'),
    hit('10.5555/placeholder', 'No abstract available.'),
  ]));
  const records = await fetchInspireAbstracts(['10.5555/markup', '10.5555/placeholder']);
  assert.equal(records.length, 1);
  assert.match(records[0].abstract!, /A & B study/);
  assert.match(records[0].abstract!, /x\^2/);
  assert.doesNotMatch(records[0].abstract!, /<\/?p>/);
});

test('overlapping callers share the serial lane and cached DOI response', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response([hit('10.5555/concurrent', 'Source text.')]));
  const [a, b] = await Promise.all([fetchInspireAbstracts(['10.5555/concurrent']), fetchInspireAbstracts(['10.5555/concurrent'])]);
  assert.deepEqual(a, b);
  assert.equal(fetch.mock.callCount(), 1);
});

test('bounds work to two batches and quotes DOI query syntax', async t => {
  const queries: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get('q')!);
    assert.equal(url.searchParams.get('size'), '25');
    return response([]);
  });
  await fetchInspireAbstracts(['invalid', 'https://example.com', '10.5555/"OR"', ...Array.from({ length: 50 }, (_, i) => `10.5555/bounded-${i}`)]);
  assert.equal(queries.length, 2);
  assert.ok(queries[0].startsWith('doi:"10.5555/\\"or\\"" OR '));
  assert.equal(queries.some(query => query.includes('bounded-49')), false);
});

test('truncated results are neither merged nor cached as absent', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ hits: { total: 30, hits: [hit('10.5555/truncated', 'Incomplete match.')] } }));
  assert.deepEqual(await fetchInspireAbstracts(['10.5555/truncated']), []);
  fetch.mock.mockImplementation(async () => response([hit('10.5555/truncated', 'Complete match.')]));
  assert.equal((await fetchInspireAbstracts(['10.5555/truncated']))[0].abstract, 'Complete match.');
});

test('errors and rate limits preserve absence, honor Retry-After, and recover later', async t => {
  const clock = t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(fetchInspireAbstracts(['10.5555/retry']), /429/);
  assert.deepEqual(await fetchInspireAbstracts(['10.5555/retry']), []);
  clock.mock.mockImplementation(() => 2_000_000_060_001);
  assert.deepEqual(await fetchInspireAbstracts(['10.5555/retry']), []);
  assert.equal(fetch.mock.callCount(), 1);
  clock.mock.mockImplementation(() => 2_000_000_120_001);
  fetch.mock.mockImplementation(async () => Response.json({ hits: { hits: [{}], total: 1 } }));
  await assert.rejects(fetchInspireAbstracts(['10.5555/retry']), /Invalid INSPIRE/);
  clock.mock.mockImplementation(() => 2_000_000_180_002);
  fetch.mock.mockImplementation(async () => response([hit('10.5555/retry', 'Recovered source text.')]));
  assert.equal((await fetchInspireAbstracts(['10.5555/retry']))[0].abstract, 'Recovered source text.');
  // Keep later tests outside this simulated cooldown.
  clock.mock.mockImplementation(() => 2_000_000_240_003);
});

test('the lookup deadline covers a response whose body stalls', { timeout: 8_000 }, async t => {
  t.mock.method(Date, 'now', () => 2_000_001_000_000);
  t.mock.method(globalThis, 'fetch', dribblingFetch());
  assert.equal(await settleWithin(7_000, () => fetchInspireAbstracts(['10.5555/stalled'])), 'TimeoutError');
});

/** An INSPIRE that answers each query with its own DOI's abstract after `delayMs`, and drops the request if aborted. */
function inspireAnsweringAfter(delayMs: number, sent: string[]): typeof fetch {
  return (input, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    const query = new URL(String(input)).searchParams.get('q')!;
    sent.push(query);
    const doi = query.match(/doi:"([^"]+)"/)![1];
    const timer = setTimeout(() => resolve(response([hit(doi, `Abstract of ${doi}.`)])), delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

test('time spent queued behind another lookup does not count against the deadline or pause INSPIRE', { timeout: 10_000 }, async t => {
  // Each answer takes 3.5 s. The second lookup starts after 3.5 s and must still get a full 6 s.
  t.mock.method(Date, 'now', () => 2_000_002_000_000);
  const sent: string[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', inspireAnsweringAfter(3_500, sent));
  const [first, second] = await Promise.all([
    fetchInspireAbstracts(['10.5555/queued-first']),
    fetchInspireAbstracts(['10.5555/queued-second']),
  ]);
  assert.deepEqual(first.map(record => record.doi), ['10.5555/queued-first']);
  assert.deepEqual(second.map(record => record.doi), ['10.5555/queued-second']);
  // INSPIRE is healthy, so a later lookup is sent, and answers at once here.
  fetch.mock.mockImplementation(inspireAnsweringAfter(0, sent));
  const third = await fetchInspireAbstracts(['10.5555/queued-third']);
  assert.deepEqual(third.map(record => record.abstract), ['Abstract of 10.5555/queued-third.']);
  assert.deepEqual(sent, ['doi:"10.5555/queued-first"', 'doi:"10.5555/queued-second"', 'doi:"10.5555/queued-third"']);
});
