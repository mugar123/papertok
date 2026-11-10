import type { Paper } from '../models/paper.ts';
import type { CorpusPageRequest, LoadingFollow } from '../services/paper-store-service.ts';
import { corpusRequestOf, ingredientKey, type CustomFeed, type FeedIngredient } from './custom-feeds.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from './feed-interactions.ts';
import { createSessionCache } from './session-cache.ts';

// The pages a custom feed has been served, merged into one list, and the
// decisions its page makes from them: what to ask the corpus for, whether the
// list may go on, and why an empty list is empty.

export const CUSTOM_FEED_PAGE_SIZE = 15;

export interface CustomFeedPages { papers: Paper[]; page: number; hasMore: boolean; loading: LoadingFollow[] }

/**
 * The feed's list once page `page` arrives: the first page starts it, a later
 * one adds the papers the list does not hold yet. A page with fewer papers
 * than a page holds is the last. `loading` is the latest answer's.
 */
export function mergeFeedPage(current: CustomFeedPages | null, incoming: { papers: Paper[]; loading: LoadingFollow[] }, page: number): CustomFeedPages {
  const papers = page === 0 || !current ? [] : [...current.papers];
  const held = new Set(papers.map(paper => paper.id));
  for (const paper of incoming.papers) {
    if (held.has(paper.id)) continue;
    held.add(paper.id);
    papers.push(paper);
  }
  return { papers, page, hasMore: incoming.papers.length >= CUSTOM_FEED_PAGE_SIZE, loading: incoming.loading };
}

/**
 * Where an account's pages of a feed are kept: a new key when the account,
 * the ingredients or the order change, the same one when only the name does.
 */
export function feedPagesKey(uid: string, feed: CustomFeed): string {
  return JSON.stringify([uid, feed.id, feed.order, feed.ingredients.map(ingredientKey)]);
}

/** What every page of one run (a first page or a refresh, and the pages after it) is ranked by and leaves out. */
export interface FeedRunSignals { positiveIds: string[]; excludedIds: string[] }

/**
 * The signals of page `page`: taken afresh on a run's first page from the
 * reader's newest examples (cut to the cap For You's request uses) and the
 * papers removed from the feed (oldest first, sent newest first so the newest
 * are the ones kept when the request is trimmed); the run's own on every later
 * page, so `page` always indexes the same order. A later page with no run
 * known (the session forgot it) takes them afresh.
 */
export function feedRunSignals(run: FeedRunSignals | null, page: number, latest: { positiveIds: string[]; dismissed: string[] }): FeedRunSignals {
  if (run && page > 0) return run;
  return { positiveIds: latest.positiveIds.slice(0, SEMANTIC_PROFILE_POSITIVE_CAP), excludedIds: [...latest.dismissed].reverse() };
}

/**
 * What a feed's page does by itself when it opens: shows the pages the
 * session kept (they carry their own run, so they need no examples and start
 * no new one), starts its first run once the reader's profile is ready, or
 * waits for it, so a run never locks in examples the profile has not given yet.
 */
export function feedOpening(hasPages: boolean, profileReady: boolean): 'show' | 'start' | 'wait' {
  if (hasPages) return 'show';
  return profileReady ? 'start' : 'wait';
}

/**
 * Page `page` of the feed with its run's signals. Null when the feed names
 * nothing the corpus can serve, which it would refuse (LANES_REQUIRED).
 */
export function feedPageRequest(feed: CustomFeed, signals: FeedRunSignals, page: number): CorpusPageRequest & { exact: true } | null {
  const lanes = corpusRequestOf(feed);
  if (!lanes.categories.length && !lanes.areas.length && !lanes.follows.length) return null;
  return { ...lanes, exact: true, positiveIds: signals.positiveIds, excludedIds: signals.excludedIds, page, pageSize: CUSTOM_FEED_PAGE_SIZE };
}

/**
 * How many pages in a row a feed asks for by itself while every paper it was
 * given is one the reader took out; then it stops and shows itself empty,
 * and only a refresh asks again.
 */
export const MAX_EMPTY_AUTO_PAGES = 3;

/** Whether the feed asks for its next page by itself: it shows nothing, has more, and has not used up its automatic pages. */
export function advancesByItself(hasMore: boolean, shown: number, emptyAdvances: number): boolean {
  return hasMore && shown === 0 && emptyAdvances < MAX_EMPTY_AUTO_PAGES;
}

/** The feed's ingredients whose follow the answer says is still loading. */
export function loadingIngredientsOf(feed: CustomFeed, loading: CustomFeedPages['loading']): FeedIngredient[] {
  const pending = new Set(loading.map(({ type, canonicalId }) => `${type}\n${canonicalId}`));
  return feed.ingredients.filter((ingredient) => {
    const [follow] = corpusRequestOf({ ...feed, ingredients: [ingredient] }).follows;
    return follow !== undefined && pending.has(`${follow.type}\n${follow.canonicalId}`);
  });
}

/**
 * Why the feed shows no papers: some of its follows are still being gathered,
 * it has nothing, or it failed. Null while it has papers, or before its first
 * answer.
 */
export function feedEmptyKind(pages: CustomFeedPages | null, error: unknown): 'gathering' | 'nothing' | 'error' | null {
  if (pages?.papers.length) return null;
  if (error) return 'error';
  if (!pages) return null;
  return pages.loading.length ? 'gathering' : 'nothing';
}

/** Each feed's pages for the session, so its page, remounted on every visit, resumes where the reader left it. */
export const customFeedPagesCache = createSessionCache<CustomFeedPages>({ maxEntries: 8 });

/** The run each cached list's pages belong to, under the same key, so a resumed list's next page keeps its order. */
export const customFeedRunsCache = createSessionCache<FeedRunSignals>({ maxEntries: 8 });

export function forgetCustomFeedPages(): void {
  customFeedPagesCache.clear();
  customFeedRunsCache.clear();
}

/**
 * Forgets one account's pages and runs of one feed, under every key it was
 * kept by (`feedPagesKey`: each order and set of ingredients it had), as when
 * the feed is deleted. Other feeds and accounts keep theirs.
 */
export function forgetCustomFeedPagesOf(uid: string, feedId: string): void {
  // The JSON array's opening: `["<uid>","<feedId>",`.
  const prefix = `${JSON.stringify([uid, feedId]).slice(0, -1)},`;
  const belongs = (key: string) => key.startsWith(prefix);
  customFeedPagesCache.deleteWhere(belongs);
  customFeedRunsCache.deleteWhere(belongs);
}
