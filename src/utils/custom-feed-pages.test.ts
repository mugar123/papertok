import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import type { CustomFeed } from './custom-feeds.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';
import {
  MAX_EMPTY_AUTO_PAGES,
  advancesByItself,
  customFeedPagesCache,
  customFeedRunsCache,
  feedEmptyKind,
  feedOpening,
  feedPageRequest,
  feedPagesKey,
  feedRunSignals,
  forgetCustomFeedPagesOf,
  loadingIngredientsOf,
  mergeFeedPage,
} from './custom-feed-pages.ts';
import { parseFeedIngredient, type FeedIngredient } from './custom-feeds.ts';

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

/** Asks for the feed's pages as the reader scrolling to its end does: the next one while the list has more. */
async function readToTheEnd(answers: unknown[]) {
  const { asked, options } = workerAnswering(answers);
  const run = feedRunSignals(null, 0, { positiveIds: [], dismissed: [] });
  let pages = mergeFeedPage(null, await fetchCorpusPage(feedPageRequest(quantFeed, run, 0)!, options), 0);
  while (pages.hasMore && asked.length < 10) {
    const page = pages.page + 1;
    pages = mergeFeedPage(pages, await fetchCorpusPage(feedPageRequest(quantFeed, run, page)!, options), page);
  }
  return { asked, pages };
}

test('from a Worker that does not say `more`, a page with fewer papers than asked is the last; a paper already held is not added twice', () => {
  const first = mergeFeedPage(null, { papers: papersOf('p', 15), loading: [] }, 0);
  assert.equal(first.papers.length, 15);
  assert.equal(first.hasMore, true);
  assert.equal(first.page, 0);

  const second = mergeFeedPage(first, { papers: [paperOf('p3'), paperOf('q1'), paperOf('q2')], loading: [] }, 1);
  assert.equal(second.papers.length, 17);
  assert.deepEqual(second.papers.slice(15).map(held => held.id), ['q1', 'q2']);
  assert.equal(second.hasMore, false);
  assert.equal(second.page, 1);
});

test('the Worker\'s `more` decides whether the list goes on, whatever the page holds', () => {
  assert.equal(mergeFeedPage(null, { papers: papersOf('p', 14), loading: [], more: true }, 0).hasMore, true);
  assert.equal(mergeFeedPage(null, { papers: [], loading: [], more: true }, 0).hasMore, true);
  assert.equal(mergeFeedPage(null, { papers: papersOf('p', 15), loading: [], more: false }, 0).hasMore, false);
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
  const first = mergeFeedPage(null, { papers: [...papersOf('a', 13), retracted, erratum], loading: [] }, 0);
  assert.deepEqual(first.papers.map(held => held.id), papersOf('a', 13).map(held => held.id));
  assert.equal(first.hasMore, true);

  // Nor does a page of nothing but such papers end the list.
  const second = mergeFeedPage(first, { papers: papersOf('b', 15).map(held => ({ ...held, publicationStatus: 'retracted' as const })), loading: [] }, 1);
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
  // A refresh starts a new run, with what changed.
  const refreshed = feedRunSignals(run, 0, later);
  assert.deepEqual(refreshed, { positiveIds: ['2611.00042', '2610.00001'], excludedIds: ['2611.00003', '2611.00007', '2610.00008'] });
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
