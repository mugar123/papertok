import type { FeedPlan } from '../context/feed-corpus-requests.ts';
import type { Paper } from '../models/paper.ts';
import type { CorpusPageRequest } from '../services/paper-store-service.ts';
import type { CustomFeedPages } from './custom-feed-pages.ts';
import { hasSeenRanking } from '../context/feed-pagination.ts';
import { feedSeenIds } from './seen-paper-filter.ts';
import { createSessionCache, type SessionCache } from './session-cache.ts';

export const RECENT_PAGE_SIZE = 15;

/** What a new list of the reader's interests asks the corpus with (FeedContext's `getInterestRunSignals`). */
export interface InterestRunSignals { plan: FeedPlan; negativeIds: string[]; excludedIds: string[]; viewedIds: string[] }

/**
 * What every page of one run asks with, and every paper its answers brought
 * (shown or not), oldest first. `walk` is the run's id, drawn when it starts:
 * the corpus keeps a walk of the order for each id, so another run of the
 * same reader, such as one in another tab, does not move this one on.
 */
export interface RecentRun { plan: FeedPlan; negativeIds: string[]; excludedIds: string[]; received: string[]; walk: string }

/**
 * The run a page belongs to: a later page goes on with the run it continues,
 * whose groups, rejections, exclusions and walk id every page asks with, so
 * the corpus goes on with the same walk. A first page, or a later one with no
 * run, starts a new run from the latest signals, with a new walk id.
 */
export function recentRunFor(current: RecentRun | null, page: number, latest: InterestRunSignals): RecentRun {
  if (current && page > 0) return current;
  return { plan: latest.plan, negativeIds: latest.negativeIds, excludedIds: latest.excludedIds, received: [], walk: crypto.randomUUID() };
}

/**
 * The seen papers a page sends, oldest first: what the reader viewed, then
 * what the run's answers brought as the newest. The corpus walks again from
 * the first paper of its last answer, so the run moves on only past what it
 * is told it received. A paper listed twice keeps its newest place, and the
 * request holds the 2,000 newest (`feedSeenIds`).
 */
export function recentSeenIds(viewedIds: string[], received: string[]) {
  const ids = new Set<string>();
  for (const paperId of [...viewedIds, ...received]) {
    ids.delete(paperId);
    ids.add(paperId);
  }
  return feedSeenIds(ids, true);
}

/**
 * A Most recent page: For you's main request ordered by day, with no notable
 * cards, follows or exploration, and named by its run's walk id. A reader
 * with no interest groups asks for nothing.
 */
export function recentPageRequest(run: RecentRun, page: number, seenIds: string[]): CorpusPageRequest | null {
  if (run.plan.groups.length === 0) return null;
  return {
    groups: run.plan.groups,
    positiveIds: run.plan.unassignedPositiveIds,
    negativeIds: run.negativeIds,
    excludedIds: run.excludedIds,
    seen: new Set(seenIds),
    order: 'daily',
    walk: run.walk,
    page,
    pageSize: RECENT_PAGE_SIZE,
  };
}

/**
 * What a page shows of its answer. `held` is the seen ids the request sent
 * and `viewed` every paper the reader viewed. A corpus that skips seen papers
 * and still sends one it was told about has no unseen papers left in the
 * order (`hasSeenRanking`), so the run ends there, as it does on an empty
 * answer. Its short pages do not end the run: it can drop a paper between
 * walking the order and reading the rows. A corpus that does not skip seen
 * papers ends the run on a short page. Every paper of the answer counts as
 * received, shown or not, so the next page walks past it.
 */
export function settleRecentPage(answer: { papers: Paper[]; skipsSeen: boolean }, held: ReadonlySet<string>, viewed: ReadonlySet<string>) {
  const received = answer.papers.map(paper => paper.id);
  const papers = answer.papers.filter(paper => !held.has(paper.id) && !viewed.has(paper.id));
  const hasMore = answer.skipsSeen
    ? answer.papers.length > 0 && !hasSeenRanking(answer, held)
    : answer.papers.length >= RECENT_PAGE_SIZE;
  return { papers, hasMore, received };
}

/**
 * Where an account's Most recent list is kept: a new key when the account or
 * its topics change, the same one when only their order does.
 */
export function recentPagesKey(uid: string, topics: string[]): string {
  return JSON.stringify([uid, [...new Set(topics)].sort()]);
}

/** Where FeedContainer keeps the card an account's Most recent was left on (feed-resume-memory.ts). */
export const recentScrollKey = (uid: string) => `recent:${uid}`;

/**
 * Whether the list for `key` starts new, and so opens on its first card: the
 * profile has loaded, so `key` names the account's topics, and the session
 * kept no pages under it (a reload, a first visit, new topics, another
 * account). The card a reload remembers belongs to a list that is gone.
 */
export function startsNewRecentList(key: string | null, ready: boolean, kept: Pick<SessionCache<CustomFeedPages>, 'get'>): boolean {
  return key !== null && ready && kept.get(key) === undefined;
}

/** The list's pages for the session, so the page, remounted on every visit, resumes where the reader left it. */
export const recentPagesCache = createSessionCache<CustomFeedPages>({ maxEntries: 2 });

/** The run each kept list's pages belong to, under the same key, so a resumed list's next page goes on with it. */
export const recentRunsCache = createSessionCache<RecentRun>({ maxEntries: 2 });

export function forgetRecentPages(): void {
  recentPagesCache.clear();
  recentRunsCache.clear();
}
