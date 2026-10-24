import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/Paper.ts';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.ts';
import { classifyFeedPublications, dropUnreachedPublications } from './feedPublicationService.ts';
import { placeNotableCards } from '../utils/feedEnrichment.ts';
import { isFeedPublication } from './feedPublicationRules.ts';
import { dribblingFetch } from '../test-support/deadlineHarness.ts';

// Reduced from the OpenAlex and Crossref responses captured on 2026-10-18
// for the four cards without abstracts in the user's video.
const video = [
  { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals: An Introduction', crossref: 'book' },
  { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013', crossref: 'book' },
  { id: 'W1998067413', doi: '10.2307/2309205', title: 'Introduction to Algebraic Geometry.', crossref: 'journal-article' },
  { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry', crossref: 'journal-article' },
];
const adapter = new OpenAlexAdapter();
const candidates = video.map(work => adapter.mapToStandard({
  id: `https://openalex.org/${work.id}`, doi: `https://doi.org/${work.doi}`, title: work.title,
  type: 'article', abstract_inverted_index: null,
})!);

function paper(doi: string, publicationType = 'article'): Paper {
  return { id: doi, doi, publicationType, title: 'Synthetic publication', abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] } };
}
const doisFrom = (input: string | URL | Request) => new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
const response = (items: Array<{ DOI: string; type: string }>) => Response.json({ message: { items, 'total-results': items.length } });
const typesResponse = (input: string | URL | Request, type: string) => response(doisFrom(input).map(DOI => ({ DOI, type })));
// A separate instance of the module, as after a reload: its own cache, lane and pause.
const freshSession = (name: string) => import(new URL(`./feedPublicationService.ts?${name}`, import.meta.url).href) as Promise<typeof import('./feedPublicationService.ts')>;
const flush = () => new Promise(resolve => setImmediate(resolve));

function withStorage(t: import('node:test').TestContext) {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Partial<typeof globalThis>).localStorage;
  });
  return store;
}

test('the seven audited OpenAlex records exclude only confirmed books and bibliographic reviews', async t => {
  // Reduced from the 2026-10-18 live audit; Crossref calls all five DOIs journal-article.
  const works = [
    ['W3092894041', '10.2307/2307774', 'Introduction to Algebraic Geometry.'],
    ['W2061512179', '10.1016/0370-2693(86)90963-9', 'Algebraic geometry and the geometry of quantum strings'],
    ['W2010528264', '10.1007/bf01135528', 'Integration of nonlinear equations by the methods of algebraic geometry'],
    ['W2067811790', '10.1007/bf01231766', 'Symplectic packings and algebraic geometry'],
    ['W3150920821', '10.1038/162006a0', 'Methods of Algebraic Geometry'],
    ['W1503277431', '', 'Convex Bodies and Algebraic Geometry: An Introduction to the Theory of Toric Varieties'],
    ['W2326857801', '', 'Introduction to the minimal model problem, in Algebraic Geometry, Sendai, 1985'],
  ].map(([id, doi, title]) => adapter.mapToStandard({ id: `https://openalex.org/${id}`, doi, title, type: 'article', abstract_inverted_index: null })!);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => typesResponse(input, 'journal-article'));
  const result = await classifyFeedPublications(works);
  assert.deepEqual(result.map(work => work.publicationType), ['book-review', 'article', 'article', 'article', 'book-review', 'book', 'article']);
  assert.deepEqual(result.filter(isFeedPublication).map(work => work.id), [
    'openalex:W2061512179', 'openalex:W2010528264', 'openalex:W2067811790', 'openalex:W2326857801',
  ]);
  assert.deepEqual(result[4].sources.enrichedBy, ['nature']);
  assert.deepEqual(result[5].sources.enrichedBy, ['springer']);
  for (const index of [1, 2, 3, 6]) assert.equal(result[index], works[index]);
  assert.equal(isFeedPublication({ id: 'openalex:W999', title: works[5].title, publicationType: 'review' }), true);
  assert.equal(isFeedPublication({ ...works[5], id: 'W1503277431' }), false, 'followed-entity candidates use bare OpenAlex IDs');
  assert.equal(isFeedPublication({ ...works[5], id: 'W1503277431', sources: { primary: 'other', enrichedBy: [] } }), true);
});

test('PRISMA 2020 stays a scientific review through discovery and Crossref classification', async t => {
  // Reduced from OpenAlex W3118615836, retrieved 2026-10-18.
  const review = adapter.mapToStandard({
    id: 'https://openalex.org/W3118615836', doi: 'https://doi.org/10.1136/bmj.n71',
    title: 'The PRISMA 2020 statement: an updated guideline for reporting systematic reviews', type: 'review',
  })!;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => typesResponse(input, 'journal-article'));
  const filter = new URL(adapter.buildSearchUrl('systematic reviews')).searchParams.get('filter');
  assert.ok(filter?.split('type:')[1].split('|').includes('review'));
  assert.deepEqual((await classifyFeedPublications([review])).filter(isFeedPublication), [review]);
  assert.equal(review.publicationType, 'review');
});

test('the video books and bibliographic review are excluded, but its research article remains', async t => {
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = doisFrom(input);
    requested.push(...dois);
    return response(dois.map(DOI => ({ DOI, type: video.find(work => work.doi === DOI)!.crossref })));
  });
  const classified = await classifyFeedPublications(candidates);
  assert.deepEqual(classified.map(work => work.publicationType), ['book', 'book', 'book-review', 'article']);
  assert.deepEqual(classified.filter(isFeedPublication).map(work => work.id), ['openalex:W3029239115']);
  assert.equal(requested.includes('10.2307/2309205'), false);
  assert.deepEqual(classified[0].sources.enrichedBy, ['crossref']);
  assert.deepEqual(classified[2].sources.enrichedBy, ['jstor']);
  assert.equal(classified[3], candidates[3]);
  assert.equal(candidates[0].publicationType, 'article', 'classification must not mutate source records');
});

test('scientific reviews, book chapters, preprints and research without abstracts remain eligible', async t => {
  const reviews = [paper('10.5555/scientific-review', 'review'), paper('10.5555/chapter', 'book-chapter'), paper('10.5555/preprint', 'preprint')];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => typesResponse(input, 'journal-article'));
  const classified = await classifyFeedPublications(reviews);
  assert.deepEqual(classified.filter(isFeedPublication), reviews);
  assert.equal(classified[0].publicationType, 'review');
  assert.ok(isFeedPublication({ title: 'A review of books in mathematics', publicationType: 'review' }));
});

test('the editorial correction uses the canonical DOI, never a matching title or book edition', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  const review = { ...paper('https://doi.org/10.2307/2309205'), sources: { primary: 'crossref', enrichedBy: [] } };
  const sameTitle = { ...paper(''), title: 'Introduction to Algebraic Geometry.' };
  const classified = await classifyFeedPublications([review, sameTitle]);
  assert.equal(classified[0].publicationType, 'book-review');
  assert.deepEqual(classified.filter(isFeedPublication), [sameTitle]);
  assert.equal(fetch.mock.callCount(), 0);
});

test('canonical DOI cache avoids repeat requests across feed batches and duplicate records', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => typesResponse(input, 'book'));
  const records = [paper('10.5555/CACHE-BOOK'), paper('https://doi.org/10.5555/cache-book')];
  assert.deepEqual((await classifyFeedPublications(records)).filter(isFeedPublication), []);
  assert.deepEqual((await classifyFeedPublications(records)).filter(isFeedPublication), []);
  assert.equal(fetch.mock.callCount(), 1);
});

test('missing and malformed DOI values are not queried or inferred from the title', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  const records = [paper(''), paper('https://example.com/book'), paper('10.5555/x,type:book')];
  assert.deepEqual(await classifyFeedPublications(records), records);
  assert.equal(fetch.mock.callCount(), 0);
});

test('an empty Crossref result leaves unknown publications eligible and caches the absence of evidence', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response([]));
  const records = [paper('10.5555/missing-record')];
  assert.deepEqual((await classifyFeedPublications(records)).filter(isFeedPublication), records);
  await classifyFeedPublications(records);
  assert.equal(fetch.mock.callCount(), 1);
});

test('an outage or mismatched DOI cannot exclude research and is retried on the next batch', async t => {
  t.mock.method(console, 'warn', () => {});
  const records = [paper('10.5555/provider-recovery')];
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  assert.deepEqual(await classifyFeedPublications(records), records);
  fetch.mock.mockImplementation(async () => response([{ DOI: '10.5555/a-different-work', type: 'book' }]));
  assert.deepEqual(await classifyFeedPublications(records), records);
  fetch.mock.mockImplementation(async (input: string | URL | Request) => typesResponse(input, 'book'));
  assert.deepEqual((await classifyFeedPublications(records)).filter(isFeedPublication), []);
  assert.equal(fetch.mock.callCount(), 3);
});

test('known books and bibliographic reviews are excluded without excluding scientific reviews', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  const records = ['book', 'edited-book', 'monograph', 'reference-book', 'book-set', 'book-series', 'book-review'].map(type => paper(`10.5555/${type}`, type));
  assert.deepEqual((await classifyFeedPublications(records)).filter(isFeedPublication), []);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(isFeedPublication(paper('10.5555/literature-review', 'review')), true);
});

test('a large candidate pool uses bounded DOI batches and reuses cached classifications', async t => {
  const calls: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const dois = doisFrom(input);
    calls.push(dois);
    assert.equal(url.searchParams.get('select'), 'DOI,type');
    assert.equal(Number(url.searchParams.get('rows')), dois.length);
    assert.ok(dois.length <= 20);
    return typesResponse(input, 'book');
  });
  const records = Array.from({ length: 85 }, (_, i) => paper(`10.5555/bounded-${i}`));
  const first = await classifyFeedPublications(records);
  assert.equal(calls.length, 4);
  assert.deepEqual(first.filter(isFeedPublication), records.slice(80));
  const second = await classifyFeedPublications(records);
  assert.deepEqual(second.filter(isFeedPublication), []);
  assert.equal(calls.length, 5);
  assert.equal(calls[4].length, 5);
});

test('overlapping loads share cached DOI results and leave other providers immediately available', async t => {
  let release!: () => void;
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    started();
    await pending;
    return typesResponse(input, 'book');
  });
  const records = [paper('10.5555/overlapping')];
  const first = classifyFeedPublications(records);
  await active;
  const second = classifyFeedPublications(records);
  const arxiv = [{ ...paper('10.5555/arxiv-copy'), sources: { primary: 'arxiv', enrichedBy: [] } }];
  try {
    assert.deepEqual(await classifyFeedPublications(arxiv), arxiv);
  } finally {
    release();
  }
  for (const classified of await Promise.all([first, second])) assert.deepEqual(classified.filter(isFeedPublication), []);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a stalled lookup ends at its deadline and pauses Crossref for the next pages, then retries', { timeout: 5_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { classifyFeedPublications: classify } = await freshSession('stalled');
  const records = [paper('10.5555/stalled-body')];
  const fetch = t.mock.method(globalThis, 'fetch', dribblingFetch());
  const stalled = classify(records);
  await flush();
  t.mock.timers.tick(10_000);
  assert.deepEqual(await stalled, records);
  assert.equal(fetch.mock.callCount(), 1);

  fetch.mock.mockImplementation(async (input: string | URL | Request) => typesResponse(input, 'book'));
  assert.deepEqual(await classify([paper('10.5555/next-page')]), [paper('10.5555/next-page')]);
  assert.equal(fetch.mock.callCount(), 1, 'the next page does not ask a Crossref that just timed out');

  t.mock.timers.tick(60 * 60 * 1000);
  assert.deepEqual((await classify(records)).filter(isFeedPublication), []);
  assert.equal(fetch.mock.callCount(), 2);
});

test('a lookup queued behind another gets its own deadline, so Crossref answering in time is asked for the next page', { timeout: 5_000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { classifyFeedPublications: classify } = await freshSession('queued');
  // 3.5 s per request, the slowest Crossref answer in the PAP-51 measurements.
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 3_500);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
    });
    return typesResponse(input, 'journal-article');
  });
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      t.mock.timers.tick(100);
      for (let turn = 0; turn < 5; turn += 1) await flush();
    }
  };
  const first = classify([paper('10.5555/first-page')]);
  await advance(500);
  const second = classify([paper('10.5555/top-up')]);
  await advance(8_000);
  await Promise.all([first, second]);
  assert.equal(fetch.mock.callCount(), 2);
  const third = classify([paper('10.5555/next-page')]);
  await advance(4_000);
  await third;
  assert.equal(fetch.mock.callCount(), 3);
});

test('types found before a reload exclude a book without asking Crossref again', async t => {
  withStorage(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => typesResponse(input, 'book'));
  const records = [paper('10.5555/remembered-book')];
  assert.deepEqual((await (await freshSession('before-reload')).classifyFeedPublications(records)).filter(isFeedPublication), []);
  const afterReload = await freshSession('after-reload');
  assert.deepEqual((await afterReload.classifyFeedPublications(records)).filter(isFeedPublication), []);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(afterReload.applyKnownPublicationTypes(records).filter(isFeedPublication), []);
});

test('stored types that are not a valid DOI, type or lifetime are ignored', async t => {
  const store = withStorage(t);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => typesResponse(input, 'journal-article'));
  const remembered = paper('10.5555/remembered-article');
  await (await freshSession('valid-store')).classifyFeedPublications([remembered]);
  const [key] = [...store.keys()];
  const now = Date.now();
  store.set(key, JSON.stringify({
    '10.5555/far-future': ['book', now + 365 * 24 * 60 * 60 * 1000],
    '10.5555/odd-type': ['Book; drop', now + 60_000],
    'https://doi.org/10.5555/raw-doi': ['book', now + 60_000],
  }));
  const later = await freshSession('tampered-store');
  const stored = ['10.5555/far-future', '10.5555/odd-type', 'https://doi.org/10.5555/raw-doi'].map(doi => paper(doi));
  assert.deepEqual(later.applyKnownPublicationTypes(stored), stored);
});

test('malformed and truncated batch responses do not create cached classifications', async t => {
  t.mock.method(console, 'warn', () => {});
  const records = [paper('10.5555/invalid-batch')];
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { items: [] } }));
  assert.deepEqual(await classifyFeedPublications(records), records);
  fetch.mock.mockImplementation(async () => Response.json({ message: { items: [], 'total-results': 1 } }));
  assert.deepEqual(await classifyFeedPublications(records), records);
  fetch.mock.mockImplementation(async (input: string | URL | Request) => typesResponse(input, 'book'));
  assert.deepEqual((await classifyFeedPublications(records)).filter(isFeedPublication), []);
});

test('a rate limit stops the batch and honors Retry-After across subsequent loads', async t => {
  t.mock.method(console, 'warn', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  const records = Array.from({ length: 30 }, (_, i) => paper(`10.5555/rate-limited-${i}`));
  assert.deepEqual(await classifyFeedPublications(records), records);
  assert.deepEqual(await classifyFeedPublications(records), records);
  assert.equal(fetch.mock.callCount(), 1);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 121_000);
  fetch.mock.mockImplementation(async (input: string | URL | Request) => typesResponse(input, 'book'));
  assert.deepEqual((await classifyFeedPublications([records[0]])).filter(isFeedPublication), []);
});

test('a reported card that is no longer listed leaves every card in place, since the reader could be on any of them', () => {
  const papers = Array.from({ length: 8 }, (_, index) => paper(`10.5555/card-${index}`));
  const classified = [paper(papers[6].doi!, 'book')];
  // A preference reset can replace the list while the ref still names a card of the old one.
  assert.equal(dropUnreachedPublications(papers, classified, '10.5555/replaced-card'), papers);
  assert.deepEqual(dropUnreachedPublications(papers, classified, null).map(work => work.id), papers.filter((_, index) => index !== 6).map(work => work.id));
  assert.deepEqual(dropUnreachedPublications(papers, classified, papers[5].id), papers);
});

// One feed card in 15 is notable (placeNotableCards). A book taken out between
// two notable cards left 14 cards between them until the next re-rank, which
// a reader who does not stop on a card may never cause.
test('a book left out after the reader leaves the notable cards after it fifteen cards apart, the other cards in their order', () => {
  const notable = (id: string): Paper => ({ ...paper(`10.5555/${id}`), _notable: true });
  const others = Array.from({ length: 45 }, (_, index) => paper(`10.5555/card-${index}`));
  const papers = placeNotableCards(others, ['notable-0', 'notable-1', 'notable-2'].map(notable));
  const notableAt = (list: Paper[]) => list.flatMap((work, index) => (work._notable ? [index] : []));
  assert.deepEqual(notableAt(papers), [14, 29, 44]);
  // The reader is on the fourth card; Crossref calls the twenty-first other card a book.
  const kept = dropUnreachedPublications(papers, [paper(others[20].doi!, 'book')], others[3].id);
  assert.deepEqual(notableAt(kept), [14, 29, 44]);
  assert.deepEqual(kept.filter(work => !work._notable).map(work => work.id), others.filter((_, index) => index !== 20).map(work => work.id));
});
