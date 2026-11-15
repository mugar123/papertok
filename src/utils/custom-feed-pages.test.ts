import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import type { CustomFeed } from './custom-feeds.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';
import {
  MAX_EMPTY_AUTO_PAGES,
  advancesByItself,
  askFeedPage,
  customFeedPagesCache,
  customFeedRunsCache,
  feedEmptyKind,
  feedOpening,
  feedPageOf,
  feedPageRequest,
  feedPagesKey,
  feedRunSignals,
  forgetCustomFeedPagesOf,
  loadingIngredientsOf,
  mergeFeedPage,
  passedPapers,
} from './custom-feed-pages.ts';
import { parseFeedIngredient, type FeedIngredient } from './custom-feeds.ts';
import type { CorpusPageRequest } from '../services/paper-store-service.ts';

const paperOf = (id: string): Paper => ({ id, title: `Paper ${id}`, abstract: '', authors: [], sources: { primary: 'arxiv', enrichedBy: [] } });
const paper = paperOf('2611.00001');
const papersOf = (prefix: string, length: number) => Array.from({ length }, (_, index) => paperOf(`${prefix}${index}`));
const quantFeed: CustomFeed = { id: 'abcd1234', name: 'Thesis', order: 'best', ingredients: [{ kind: 'category', id: 'quant-ph' }] };

/** The answer the stand-in Worker gives each page number, and the pages it was asked for. */
function workerAnswering(answers: unknown[]) {
  const asked: number[] = [];
  const fetchWorker = async (_url: string, init: RequestInit) => {
    const { page } = JSON.parse(String(init.body)) as { page: number };
    asked.push(page);
    return new Response(JSON.stringify(answers[page] ?? { papers: [], more: false }), { status: 200 });
  };
  return { asked, options: { apiBase: 'https://papertok-report-api.example', fetchWorker } };
}

/** Asks for the feed's pages as the reader scrolling to its end does (useCustomFeedPapers): the next one while the list has more. */
async function readToTheEnd(answers: unknown[]) {
  const { asked, options } = workerAnswering(answers);
  const fetchPage = (request: CorpusPageRequest & { exact: true }) => fetchCorpusPage(request, options);
  const run = feedRunSignals(null, 0, { positiveIds: [], dismissed: [] });
  let pages = mergeFeedPage(null, await askFeedPage(quantFeed, run, 0, [], fetchPage), 0);
  while (pages.hasMore && asked.length < 10) {
    const page = pages.page + 1;
    pages = mergeFeedPage(pages, await askFeedPage(quantFeed, run, page, [], fetchPage), page);
  }
  return { asked, pages };
}

test('a later page adds only the papers the list does not hold yet, and the list goes on as the caller says', () => {
  const first = mergeFeedPage(null, { papers: papersOf('p', 15), hasMore: true, loading: [] }, 0);
  assert.equal(first.papers.length, 15);
  assert.equal(first.hasMore, true);
  assert.equal(first.page, 0);

  const second = mergeFeedPage(first, { papers: [paperOf('p3'), paperOf('q1'), paperOf('q2')], hasMore: false, loading: [] }, 1);
  assert.equal(second.papers.length, 17);
  assert.deepEqual(second.papers.slice(15).map(held => held.id), ['q1', 'q2']);
  assert.equal(second.hasMore, false);
  assert.equal(second.page, 1);
});

test('a full page the caller calls the last ends the list', () => {
  const merged = mergeFeedPage(null, { papers: papersOf('p', 15), hasMore: false, loading: [] }, 0);
  assert.equal(merged.papers.length, 15);
  assert.equal(merged.hasMore, false);
});

test('the Worker\'s `more` decides whether a custom feed goes on, whatever the page holds; from a Worker that does not say, a page with fewer papers than asked is the last', () => {
  assert.equal(feedPageOf({ papers: papersOf('p', 14), loading: [], more: true }).hasMore, true);
  assert.equal(feedPageOf({ papers: [], loading: [], more: true }).hasMore, true);
  assert.equal(feedPageOf({ papers: papersOf('p', 15), loading: [], more: false }).hasMore, false);
  assert.equal(feedPageOf({ papers: papersOf('p', 15), loading: [] }).hasMore, true);
  assert.equal(feedPageOf({ papers: papersOf('p', 14), loading: [] }).hasMore, false);
});

test('an empty page the Worker says has more after it does not end the feed: every paper is shown and the end comes after the last page', async () => {
  // Page 1's fifteen works were dropped from the corpus after the ranking was kept.
  const { asked, pages } = await readToTheEnd([
    { papers: papersOf('a', 15), more: true },
    { papers: [], more: true },
    { papers: papersOf('c', 15), more: true },
    { papers: papersOf('d', 4), more: false },
  ]);
  assert.deepEqual(asked, [0, 1, 2, 3]);
  assert.deepEqual(pages.papers.map(held => held.id), [...papersOf('a', 15), ...papersOf('c', 15), ...papersOf('d', 4)].map(held => held.id));
  assert.equal(pages.hasMore, false);
  assert.equal(pages.page, 3);
});

test('a `more` that is not a boolean is not read: the feed ends at the first short page, as with a Worker that does not send it', async () => {
  for (const more of [undefined, 'true', 1, null]) {
    const { asked, pages } = await readToTheEnd([
      { papers: papersOf('a', 15), more },
      { papers: papersOf('b', 14), more },
      { papers: papersOf('c', 15), more },
    ]);
    assert.deepEqual(asked, [0, 1], String(more));
    assert.equal(pages.papers.length, 29, String(more));
    assert.equal(pages.hasMore, false, String(more));
  }
});

test('a page leaves out the papers the feed does not show, retracted or of a type it skips, and the list goes on past them', async () => {
  const retracted = { ...paperOf('a13'), publicationStatus: 'retracted' as const };
  const erratum = { ...paperOf('a14'), publicationType: 'erratum' };
  const first = mergeFeedPage(null, feedPageOf({ papers: [...papersOf('a', 13), retracted, erratum], loading: [] }), 0);
  assert.deepEqual(first.papers.map(held => held.id), papersOf('a', 13).map(held => held.id));
  assert.equal(first.hasMore, true);

  // Nor does a page of nothing but such papers end the list.
  const second = mergeFeedPage(first, feedPageOf({ papers: papersOf('b', 15).map(held => ({ ...held, publicationStatus: 'retracted' as const })), loading: [] }), 1);
  assert.equal(second.papers.length, 13);
  assert.equal(second.hasMore, true);

  const { asked, pages } = await readToTheEnd([
    { papers: [...papersOf('a', 13), retracted, erratum], more: true },
    { papers: papersOf('c', 15), more: false },
  ]);
  assert.deepEqual(asked, [0, 1]);
  assert.deepEqual(pages.papers.map(held => held.id), [...papersOf('a', 13), ...papersOf('c', 15)].map(held => held.id));
});

test('a feed with no papers whose ingredients are loading is gathering; with none loading it has nothing; a failure with no papers is an error', () => {
  assert.equal(feedEmptyKind({ papers: [], page: 0, hasMore: false, loading: [{ type: 'author', canonicalId: 'A1' }] }, null), 'gathering');
  assert.equal(feedEmptyKind({ papers: [], page: 0, hasMore: false, loading: [] }, null), 'nothing');
  assert.equal(feedEmptyKind(null, new Error('boom')), 'error');
  assert.equal(feedEmptyKind({ papers: [paper], page: 0, hasMore: false, loading: [] }, new Error('boom')), null);
});

test('the pages of a feed are kept per account and per what the feed asks for', () => {
  const feed = { id: 'abcd1234', name: 'Thesis', order: 'newest' as const, ingredients: [{ kind: 'category' as const, id: 'quant-ph' }] };
  assert.notEqual(feedPagesKey('uid-1', feed), feedPagesKey('uid-2', feed));
  assert.notEqual(feedPagesKey('uid-1', feed), feedPagesKey('uid-1', { ...feed, order: 'best' }));
  assert.equal(feedPagesKey('uid-1', feed), feedPagesKey('uid-1', { ...feed, name: 'Renamed' }));
});

test('forgetting a deleted feed drops its pages and runs under every key it had, and keeps the rest', () => {
  const feed = { id: 'abcd1234', name: 'Thesis', order: 'newest' as const, ingredients: [{ kind: 'category' as const, id: 'quant-ph' }] };
  const reordered = { ...feed, order: 'best' as const };
  const other = { ...feed, id: 'abcd12345' };
  const pages = { papers: [paper], page: 0, hasMore: false, loading: [] };
  const run = { positiveIds: [], excludedIds: [] };
  const keys = [feedPagesKey('uid-1', feed), feedPagesKey('uid-1', reordered), feedPagesKey('uid-1', other), feedPagesKey('uid-2', feed)];
  for (const key of keys) {
    customFeedPagesCache.set(key, pages);
    customFeedRunsCache.set(key, run);
  }

  forgetCustomFeedPagesOf('uid-1', 'abcd1234');

  assert.deepEqual(keys.map(key => customFeedPagesCache.get(key) !== undefined), [false, false, true, true]);
  assert.deepEqual(keys.map(key => customFeedRunsCache.get(key) !== undefined), [false, false, true, true]);
  customFeedPagesCache.clear();
  customFeedRunsCache.clear();
});

test('the ingredients still loading are the ones the answer names', () => {
  const feed: CustomFeed = {
    id: 'abcd1234',
    name: 'Thesis',
    order: 'newest',
    ingredients: [
      { kind: 'category', id: 'quant-ph' },
      { kind: 'author', id: 'A5023888391', label: 'Ana Pérez' },
      { kind: 'author', id: 'A5000000001', label: 'Luis Gómez' },
      { kind: 'topic', id: 'T10001', label: 'Quantum error correction' },
    ],
  };
  assert.deepEqual(loadingIngredientsOf(feed, [{ type: 'author', canonicalId: 'A5023888391' }]), [
    { kind: 'author', id: 'A5023888391', label: 'Ana Pérez' },
  ]);
});

test('a journal still loading is named by the source id the request sent', () => {
  const nature = { kind: 'journal' as const, id: 'S137773608', label: 'Nature' };
  const feed: CustomFeed = { id: 'abcd1234', name: 'Journals', order: 'newest', ingredients: [nature, { kind: 'journal', id: 'S4210194219', label: 'Physical Review X' }] };
  assert.deepEqual(loadingIngredientsOf(feed, [{ type: 'journal', canonicalId: 'S137773608' }]), [nature]);
});

test('a run takes the reader\'s newest examples, at most 24, and its removed papers newest first', () => {
  const examples = Array.from({ length: 30 }, (_, index) => `2610.${String(index).padStart(5, '0')}`);
  assert.deepEqual(feedRunSignals(null, 0, { positiveIds: examples, dismissed: ['2610.00008', '2610.00009'] }), {
    positiveIds: examples.slice(0, 24),
    excludedIds: ['2610.00009', '2610.00008'],
  });
});

test('every later page of a run carries exactly the signals of its first page, whatever was liked or removed in between', () => {
  const feed: CustomFeed = { id: 'abcd1234', name: 'Thesis', order: 'best', ingredients: [{ kind: 'category', id: 'quant-ph' }] };
  const run = feedRunSignals(null, 0, { positiveIds: ['2610.00001'], dismissed: ['2610.00008'] });
  const first = feedPageRequest(feed, run, 0)!;
  const later = { positiveIds: ['2611.00042', '2610.00001'], dismissed: ['2610.00008', '2611.00007', '2611.00003'] };
  const second = feedPageRequest(feed, feedRunSignals(run, 1, later), 1)!;
  assert.deepEqual(second.positiveIds, first.positiveIds);
  assert.deepEqual(second.excludedIds, first.excludedIds);
  assert.equal(second.page, 1);
  // A refresh starts a new run, with what changed, that walks past the papers the reader has seen.
  const refreshed = feedRunSignals(run, 0, later, ['2610.00050']);
  assert.deepEqual(refreshed, { positiveIds: ['2611.00042', '2610.00001'], excludedIds: ['2611.00003', '2611.00007', '2610.00008'], received: ['2610.00050'] });
});

/**
 * A stand-in corpus that holds `order`. Asked by number it answers the ranks
 * the page names and says whether any follow (`more`). Asked with `seen` it
 * answers the first papers of the order that `seen` does not hold, and when
 * none is left the page its number names, as the Worker does (`readFeedPage`).
 */
function corpusOf(order: string[]) {
  const asked: Array<{ page: number; seen: string[] | null }> = [];
  const fetchPage = async (request: CorpusPageRequest) => {
    const seen = request.seen ? [...request.seen] : null;
    asked.push({ page: request.page, seen });
    const named = order.slice(request.page * 15, (request.page + 1) * 15);
    if (!seen) return { papers: named.map(paperOf), skipsSeen: false, loading: [], more: order.length > (request.page + 1) * 15 };
    const unseen = order.filter(id => !seen.includes(id)).slice(0, 15);
    return { papers: (unseen.length ? unseen : named).map(paperOf), skipsSeen: true, loading: [] };
  };
  return { asked, fetchPage };
}

/** Refreshes the feed and scrolls to its end, as its page does: the next page while the list has more. */
async function refreshToTheEnd(order: string[], viewed: string[], passed: string[] = []) {
  const { asked, fetchPage } = corpusOf(order);
  let answer = await askFeedPage(quantFeed, feedRunSignals(null, 0, { positiveIds: [], dismissed: [] }, passed), 0, viewed, fetchPage);
  let pages = mergeFeedPage(null, answer, 0);
  const firstRun = answer.run;
  while (pages.hasMore && asked.length < 12) {
    const page = pages.page + 1;
    answer = await askFeedPage(quantFeed, answer.run, page, viewed, fetchPage);
    pages = mergeFeedPage(pages, answer, page);
  }
  return { asked, ids: pages.papers.map(item => item.id), firstRun };
}

test('a refresh starts with the papers the reader has not seen, in the feed\'s order, then goes on with the feed from its top', async () => {
  const order = Array.from({ length: 40 }, (_, index) => `2611.${String(index).padStart(5, '0')}`);
  const viewed = order.slice(0, 20);
  const { asked, ids, firstRun } = await refreshToTheEnd(order, viewed);
  assert.deepEqual(ids, [...order.slice(20), ...order.slice(0, 20)]);
  assert.deepEqual(firstRun.received, order.slice(20, 35), 'the run still walks after its first page');
  // Two pages of unseen papers, each told what the pages before it brought; a
  // third finds none, and the feed is asked from its top by number.
  assert.deepEqual(asked.map(request => [request.page, request.seen?.length ?? null]), [[0, 20], [1, 35], [2, 40], [0, null], [1, null], [2, null]]);
});

test('a refresh with no paper left unseen shows the feed from its top again, with one request', async () => {
  const order = Array.from({ length: 8 }, (_, index) => `2611.${String(index).padStart(5, '0')}`);
  const { asked, ids, firstRun } = await refreshToTheEnd(order, order);
  assert.deepEqual(ids, order);
  assert.equal(asked.length, 1);
  assert.equal(firstRun.received, undefined, 'the run no longer walks: it found nothing unseen');
});

test('a refresh passes the cards the reader went through in the list it replaces, the one on screen included', async () => {
  const order = Array.from({ length: 20 }, (_, index) => `2611.${String(index).padStart(5, '0')}`);
  const shown = order.slice(0, 15).map(paperOf);
  // On the third card: a card counts as viewed only once it is left, so the two before it are all the reader viewed.
  assert.deepEqual(passedPapers(shown, { index: 2, paperId: order[2] }), order.slice(0, 3));
  // Before any scroll: the first card.
  assert.deepEqual(passedPapers(shown, { index: 0, paperId: null }), [order[0]]);
  assert.deepEqual(passedPapers([], { index: 0, paperId: null }), []);
  // A place remembered for the list before the last refresh: its paper is not
  // there, or sits at another index of this list. The first card again.
  assert.deepEqual(passedPapers(shown, { index: 4, paperId: '2611.99999' }), [order[0]]);
  assert.deepEqual(passedPapers(shown, { index: 0, paperId: order[6] }), [order[0]]);
  const { ids } = await refreshToTheEnd(order, order.slice(0, 2), passedPapers(shown, { index: 2, paperId: order[2] }));
  assert.deepEqual(ids, [...order.slice(3), ...order.slice(0, 3)]);
});

test('opening a feed sends no seen papers and pages by number, whatever the reader viewed', async () => {
  const order = Array.from({ length: 20 }, (_, index) => `2611.${String(index).padStart(5, '0')}`);
  const { asked, fetchPage } = corpusOf(order);
  const opened = await askFeedPage(quantFeed, feedRunSignals(null, 0, { positiveIds: [], dismissed: [] }), 0, order.slice(0, 5), fetchPage);
  assert.deepEqual(opened.papers.map(item => item.id), order.slice(0, 15));
  assert.equal(opened.hasMore, true);
  assert.deepEqual(asked, [{ page: 0, seen: null }]);
});

test('a refresh answered by a Worker that does not skip seen papers is the feed from its top, paged by number', async () => {
  const order = Array.from({ length: 20 }, (_, index) => `2611.${String(index).padStart(5, '0')}`);
  const asked: number[] = [];
  const fetchPage = async (request: CorpusPageRequest) => {
    asked.push(request.page);
    return { papers: order.slice(request.page * 15, (request.page + 1) * 15).map(paperOf), skipsSeen: false, loading: [], more: request.page === 0 };
  };
  const first = await askFeedPage(quantFeed, feedRunSignals(null, 0, { positiveIds: [], dismissed: [] }, []), 0, order.slice(15), fetchPage);
  assert.deepEqual(first.papers.map(item => item.id), order.slice(0, 15));
  const second = await askFeedPage(quantFeed, first.run, 1, order.slice(15), fetchPage);
  assert.deepEqual(second.papers.map(item => item.id), order.slice(15));
  assert.equal(second.hasMore, false);
  assert.deepEqual(asked, [0, 1]);
});

test('a feed starts its first run once the reader\'s profile is ready, and shows the pages it kept without starting one', () => {
  assert.equal(feedOpening(false, true), 'start');
  assert.equal(feedOpening(false, false), 'wait');
  assert.equal(feedOpening(true, false), 'show');
  assert.equal(feedOpening(true, true), 'show');
});

test('a feed showing nothing asks for its next page by itself three times in a row, then stops', () => {
  assert.equal(MAX_EMPTY_AUTO_PAGES, 3);
  assert.deepEqual([0, 1, 2, 3].map(advances => advancesByItself(true, 0, advances)), [true, true, true, false]);
  assert.equal(advancesByItself(true, 1, 0), false, 'a paper to show');
  assert.equal(advancesByItself(false, 0, 0), false, 'no more pages');
});

test('a feed that stopped asking by itself while it shows nothing and has more offers to go on, rather than saying it has nothing', () => {
  assert.equal(feedEmptyKind({ papers: [], page: 3, hasMore: true, loading: [] }, null), 'more');
  assert.equal(feedEmptyKind({ papers: [], page: 3, hasMore: true, loading: [{ type: 'author', canonicalId: 'A1' }] }, null), 'more');
  assert.equal(feedEmptyKind({ papers: [], page: 3, hasMore: false, loading: [] }, null), 'nothing');
  assert.equal(feedEmptyKind({ papers: [], page: 3, hasMore: true, loading: [] }, new Error('boom')), 'error');
});

test('a feed page asks for exactly its lanes with its run\'s signals', () => {
  const feed: CustomFeed = {
    id: 'abcd1234',
    name: 'Thesis',
    order: 'newest',
    ingredients: [{ kind: 'area', id: 'physics' }, { kind: 'category', id: 'quant-ph' }, { kind: 'author', id: 'A5023888391', label: 'Ana Pérez' }],
  };
  assert.deepEqual(feedPageRequest(feed, { positiveIds: ['2610.00001'], excludedIds: ['2610.00009', '2610.00008'] }, 2), {
    categories: ['quant-ph'],
    areas: ['physics'],
    follows: [{ type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' }],
    order: 'daily',
    exact: true,
    positiveIds: ['2610.00001'],
    excludedIds: ['2610.00009', '2610.00008'],
    page: 2,
    pageSize: 15,
  });
});

test('a feed with nothing the corpus can serve asks for nothing', () => {
  const feed: CustomFeed = { id: 'abcd1234', name: 'Thesis', order: 'best', ingredients: [] };
  assert.equal(feedPageRequest(feed, { positiveIds: ['2610.00001'], excludedIds: [] }, 0), null);
});

test('a feed of twenty ingredients at their longest sends all twenty follows beside 200 removals and 24 examples', async () => {
  // Keyword queries at 120 characters, and author and topic labels at 200,
  // in three-byte characters, and in characters JSON would escape in six
  // bytes each (lone surrogates, control characters) until the label is cleaned.
  for (const label of ['量'.repeat(200), '\uD800'.repeat(200), '量\u0001'.repeat(100)]) {
    const char = label.slice(0, 2);
    const raw = [
      ...Array.from({ length: 10 }, (_, index) => ({ kind: 'keyword', query: `${index} ${'量'.repeat(118)}` })),
      ...Array.from({ length: 10 }, (_, index) => (index % 2
        ? { kind: 'author', id: `A${5_000_000_000 + index}`, label }
        : { kind: 'topic', id: `T${10_000 + index}`, label })),
    ];
    const ingredients = raw.map(parseFeedIngredient).filter((ingredient): ingredient is FeedIngredient => ingredient !== null);
    assert.equal(ingredients.length, 20, JSON.stringify(char));
    const feed: CustomFeed = { id: 'abcd1234', name: 'Thesis', order: 'best', ingredients };
    const run = feedRunSignals(null, 0, {
      positiveIds: Array.from({ length: 24 }, (_, index) => `https://openalex.org/W${4_000_000_000 + index}`),
      dismissed: Array.from({ length: 200 }, (_, index) => `doi:10.1234/abcdefgh.${index}`),
    });
    let sent: { follows?: unknown[] } = {};
    await fetchCorpusPage(feedPageRequest(feed, run, 0)!, {
      apiBase: 'https://papertok-report-api.example',
      fetchWorker: async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as { follows?: unknown[] };
        return new Response(JSON.stringify({ papers: [] }), { status: 200 });
      },
    });
    assert.equal(sent.follows?.length, 20, JSON.stringify(char));
  }
});

// The filter of seen papers is 3,200 characters of a request the app keeps
// under 16,000 bytes (`fetchCorpusPage`), which gives up removals, then follows.
test('a refresh sends the filter of seen papers beside all twenty follows and 200 removals when their names are in one-byte characters', async () => {
  const raw = [
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'keyword', query: `${index} ${'q'.repeat(118)}` })),
    ...Array.from({ length: 10 }, (_, index) => (index % 2
      ? { kind: 'author', id: `A${5_000_000_000 + index}`, label: 'a'.repeat(200) }
      : { kind: 'topic', id: `T${10_000 + index}`, label: 't'.repeat(200) })),
  ];
  const ingredients = raw.map(parseFeedIngredient).filter((ingredient): ingredient is FeedIngredient => ingredient !== null);
  const feed: CustomFeed = { id: 'abcd1234', name: 'Thesis', order: 'best', ingredients };
  const run = feedRunSignals(null, 0, {
    positiveIds: Array.from({ length: 24 }, (_, index) => `https://openalex.org/W${4_000_000_000 + index}`),
    dismissed: Array.from({ length: 200 }, (_, index) => `doi:10.1234/abcdefgh.${index}`),
  }, []);
  let sent: { follows?: unknown[]; excludedIds?: unknown[]; seen?: string; skipsSeen?: boolean } = {};
  await askFeedPage(feed, run, 0, ['2611.00001'], request => fetchCorpusPage(request, {
    apiBase: 'https://papertok-report-api.example',
    fetchWorker: async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent;
      return new Response(JSON.stringify({ papers: [], skipsSeen: true }), { status: 200 });
    },
  }));
  assert.equal(sent.skipsSeen, true);
  assert.equal(typeof sent.seen, 'string');
  assert.equal(sent.follows?.length, 20);
  assert.equal(sent.excludedIds?.length, 200);
});
