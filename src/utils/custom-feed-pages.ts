import type { Paper } from '../models/paper.ts';
import type { CorpusPageRequest, LoadingFollow } from '../services/paper-store-service.ts';
import { hasSeenRanking } from '../context/feed-pagination.ts';
import { isFeedPublication } from '../services/feed-publication-rules.ts';
import { corpusRequestOf, ingredientKey, type CustomFeed, type FeedIngredient } from './custom-feeds.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from './feed-interactions.ts';
import { recentSeenIds } from './recent-feed-pages.ts';
import { createSessionCache } from './session-cache.ts';

// The pages a custom feed has been served, merged into one list, and the
// decisions its page makes from them: what to ask the corpus for, whether the
// list may go on, and why an empty list is empty.

export const CUSTOM_FEED_PAGE_SIZE = 15;

export interface CustomFeedPages { papers: Paper[]; page: number; hasMore: boolean; loading: LoadingFollow[] }

/**
 * The feed's list once page `page` arrives: the first page starts it, a later
 * one adds the papers the list does not hold yet, except those the feed does
 * not show (`isFeedPublication`: a retracted paper, an erratum), as For You
 * leaves them out. `hasMore` is the caller's, from the whole answer
 * (`feedPageOf` for a custom feed): a page is merged, not judged, so the list
 * goes on past the papers left out. `loading` is the latest answer's.
 */
export function mergeFeedPage(current: CustomFeedPages | null, incoming: { papers: Paper[]; hasMore: boolean; loading: LoadingFollow[] }, page: number): CustomFeedPages {
  const papers = page === 0 || !current ? [] : [...current.papers];
  const held = new Set(papers.map(paper => paper.id));
  for (const paper of incoming.papers) {
    if (held.has(paper.id) || !isFeedPublication(paper)) continue;
    held.add(paper.id);
    papers.push(paper);
  }
  return { papers, page, hasMore: incoming.hasMore, loading: incoming.loading };
}

/**
 * Where an account's pages of a feed are kept: a new key when the account,
 * the ingredients or the order change, the same one when only the name does.
 */
export function feedPagesKey(uid: string, feed: CustomFeed): string {
  return JSON.stringify([uid, feed.id, feed.order, feed.ingredients.map(ingredientKey)]);
}

/** Where FeedContainer keeps the card an account's feed was left on (feed-resume-memory.ts). */
export const customFeedScrollKey = (feedId: string | undefined, uid: string | null | undefined) => `feed:${feedId}:${uid ?? ''}`;

/**
 * What every page of one run (a first page or a refresh, and the pages after
 * it) is ranked by and leaves out. The run a feed opens with pages by number
 * from the feed's top. A refresh's run starts with the papers the reader has
 * not seen: while it walks past the seen ones, `received` holds the papers
 * the reader went through in the list it replaced (`passedPapers`), then every
 * paper its answers brought, oldest first. Once none is left unseen,
 * `received` is gone and the run goes on by number from the feed's top, which
 * the list's page `topPage` asks for: 0 unless the walk ended on a later page.
 */
export interface FeedRunSignals { positiveIds: string[]; excludedIds: string[]; received?: string[]; topPage?: number }

/**
 * The signals of page `page`: taken afresh on a run's first page from the
 * reader's newest examples (cut to the cap For You's request uses) and the
 * papers removed from the feed (oldest first, sent newest first so the newest
 * are the ones kept when the request is trimmed); the run's own on every later
 * page, so `page` always indexes the same order. A later page with no run
 * known (the session forgot it) takes them afresh. `passed`: the run replaces
 * a list the reader already has, a refresh, so it walks past the papers they
 * have seen, those they went through in that list among them (`passedPapers`);
 * null for a feed's first run.
 */
export function feedRunSignals(run: FeedRunSignals | null, page: number, latest: { positiveIds: string[]; dismissed: string[] }, passed: string[] | null = null): FeedRunSignals {
  if (run && page > 0) return run;
  return {
    positiveIds: latest.positiveIds.slice(0, SEMANTIC_PROFILE_POSITIVE_CAP),
    excludedIds: [...latest.dismissed].reverse(),
    ...(passed ? { received: passed } : {}),
  };
}

/**
 * The papers of a shown list the reader went through: every one down to the
 * card they are on (`place`, what FeedContainer remembers for the list), that
 * card included, since a card counts as viewed only once it is left. The
 * place counts only while the list holds its paper at its index. Otherwise it
 * was remembered for another list, as before any scroll of this one, and the
 * reader is on the first card.
 */
export function passedPapers(shown: Paper[], place: { index: number; paperId: string | null }): string[] {
  const index = shown[place.index]?.id === place.paperId ? place.index : 0;
  return shown.slice(0, index + 1).map(paper => paper.id);
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
 * The list's page `page` of the feed with its run's signals. A run that walks
 * past seen papers sends them (`seen`): what the reader viewed (`viewedIds`,
 * oldest first), then what the run received. A run that pages by number sends
 * none, and asks for the page counted from the one that asked for the feed's
 * top. Null when the feed names nothing the corpus can serve, which it would
 * refuse (LANES_REQUIRED).
 */
export function feedPageRequest(feed: CustomFeed, signals: FeedRunSignals, page: number, viewedIds: string[] = []): CorpusPageRequest & { exact: true } | null {
  const lanes = corpusRequestOf(feed);
  if (!lanes.categories.length && !lanes.areas.length && !lanes.follows.length) return null;
  const request = { ...lanes, exact: true as const, positiveIds: signals.positiveIds, excludedIds: signals.excludedIds, pageSize: CUSTOM_FEED_PAGE_SIZE };
  if (signals.received) return { ...request, seen: recentSeenIds(viewedIds, signals.received), page };
  return { ...request, page: page - (signals.topPage ?? 0) };
}

/**
 * The page a custom feed's list takes from the Worker's answer to
 * `feedPageRequest` (`mergeFeedPage`). The list goes on while the answer's
 * `more` says the Worker's ranking holds papers after this page, also past a
 * page that is empty because the corpus dropped its works. From a Worker that
 * does not send `more`, a page with fewer papers than a page holds is the
 * last, counting the papers `mergeFeedPage` leaves out.
 */
export function feedPageOf(answer: { papers: Paper[]; loading: LoadingFollow[]; more?: boolean }): { papers: Paper[]; hasMore: boolean; loading: LoadingFollow[] } {
  return { papers: answer.papers, hasMore: answer.more ?? answer.papers.length >= CUSTOM_FEED_PAGE_SIZE, loading: answer.loading };
}

type FeedAnswer = { papers: Paper[]; skipsSeen: boolean; loading: LoadingFollow[]; more?: boolean };

/**
 * Asks the corpus (`fetchPage`) for the list's page `page` of the run, and
 * says what the list takes from the answer and the run its next page asks
 * with.
 *
 * A run that pages by number takes the answer as it is (`feedPageOf`). A run
 * that walks past seen papers goes on while the answer brings unseen ones,
 * each added to what it received. The corpus answers a walk with no unseen
 * paper left by the page the number names, seen papers the request held, or
 * by none; a Worker that does not skip seen papers answers by number. Either
 * way the walk is over and the run goes on by number from the feed's top: on
 * the run's first page that answer is the top, so the refresh shows the feed
 * as it was; on a later page it is not, and the top is asked for.
 * `mergeFeedPage` lists no paper twice.
 */
export async function askFeedPage(
  feed: CustomFeed,
  run: FeedRunSignals,
  page: number,
  viewedIds: string[],
  fetchPage: (request: CorpusPageRequest & { exact: true }) => Promise<FeedAnswer>,
): Promise<{ papers: Paper[]; hasMore: boolean; loading: LoadingFollow[]; run: FeedRunSignals }> {
  const request = feedPageRequest(feed, run, page, viewedIds);
  if (!request) throw new Error('The feed names nothing the corpus can serve.');
  const answer = await fetchPage(request);
  if (!run.received) return { ...feedPageOf(answer), run };
  if (answer.skipsSeen && answer.papers.length > 0 && !hasSeenRanking(answer, new Set(request.seen))) {
    return { papers: answer.papers, hasMore: true, loading: answer.loading, run: { ...run, received: [...run.received, ...answer.papers.map(paper => paper.id)] } };
  }
  const byNumber: FeedRunSignals = { positiveIds: run.positiveIds, excludedIds: run.excludedIds, ...(page > 0 ? { topPage: page } : {}) };
  if (page === 0) return { ...feedPageOf(answer), run: byNumber };
  return { ...feedPageOf(await fetchPage({ ...request, seen: undefined, page: 0 })), run: byNumber };
}

/**
 * How many pages in a row a feed asks for by itself while it has no paper to
 * show; then it stops, and while it has more the reader asks for the next page
 * (`feedEmptyKind`'s 'more').
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
 * Why the feed shows no papers: it failed, it has more pages it stopped asking
 * for by itself, some of its follows are still being gathered, or it has
 * nothing. Null while it has papers, or before its first answer.
 */
export function feedEmptyKind(pages: CustomFeedPages | null, error: unknown): 'more' | 'gathering' | 'nothing' | 'error' | null {
  if (pages?.papers.length) return null;
  if (error) return 'error';
  if (!pages) return null;
  if (pages.hasMore) return 'more';
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
