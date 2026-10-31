import type { CorpusPageRequest } from '../services/paper-store-service.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { InterestGroup, InterestMemoryInput } from '../utils/interest-memory.ts';

import { corpusPositiveIds } from '../services/paper-store-service.ts';
import { resolveWithin } from '../utils/async-timing.ts';
import { coldAddedInterests, dormantCategories, interestProgress, planInterestGroups } from '../utils/interest-memory.ts';
import { PAGE_SIZE } from './feed-pagination.ts';

// How many papers the followed entities add to a page.
export const FOLLOWED_PER_PAGE = 6;

/**
 * What the pages of one For You list rank by (ENG-137): the reader's interest
 * groups, every example they rank by, what the reader removed, how far the
 * app has learned each interest and which added ones it is still learning. The
 * scoring of the list's cards reads the last three, so they hold still with
 * the groups.
 */
export interface FeedPlan {
  groups: InterestGroup[];
  unassignedPositiveIds: string[];
  positiveIds: string[];
  dormantCategories: string[];
  interestProgress: Record<string, number>;
  coldAdded: string[];
}

type SharedRequest = Pick<CorpusPageRequest, 'page' | 'order' | 'negativeIds' | 'excludedIds' | 'seen' | 'firstScreen'>;

/**
 * The plan for a page: a new one on a list's first page, and the list's own
 * on the pages after it. The groups' weights move as the reader sees cards,
 * and the Worker's pages follow one ranking only while the groups stay the
 * same. A later page with no plan (the list came from a snapshot) plans anew.
 */
export function feedPlanFor(current: FeedPlan | null, page: number, input: InterestMemoryInput): FeedPlan {
  if (current && page > 0) return current;
  const { groups, unassignedPositiveIds } = planInterestGroups(input);
  return {
    groups,
    unassignedPositiveIds,
    positiveIds: corpusPositiveIds(groups, unassignedPositiveIds),
    dormantCategories: dormantCategories(input.selected, input.deselected),
    interestProgress: interestProgress(input),
    coldAdded: coldAddedInterests(input),
  };
}

/**
 * Whether a load's requests may wait the first screen's longer deadline
 * (`firstScreen`): a load that replaces a list with no cards shown
 * (`hasPapers` false), which is the screen the reader waits on: a cold entry,
 * an interests edit or a mode switch that emptied the list, Try again, or a
 * follow change after the error. That includes the later pages it fetches
 * while every card of its first page was seen. A load over shown cards (a
 * refresh, a follow change, an interests edit that restored a saved page,
 * their automatic retry) keeps the store's usual deadline, as do next pages.
 * The automatic retry of a first screen that timed out has had its wait
 * (`retriesTimeout`, automaticRetry in feed-load-failure.ts).
 *
 * `hasPapers` is the list of the render that started the load. A caller that
 * emptied or filled the list just before, which that render does not show
 * yet, says what is on screen with `listShown`.
 */
export function waitsAsFirstScreen({ reset, hasPapers, listShown = hasPapers, retriesTimeout = false }: { reset: boolean; hasPapers: boolean; listShown?: boolean; retriesTimeout?: boolean }) {
  return reset && !listShown && !retriesTimeout;
}

/** The reader's interests, asked by group. */
export function mainCorpusRequest(plan: FeedPlan, shared: SharedRequest): CorpusPageRequest {
  return { ...shared, groups: plan.groups, positiveIds: plan.unassignedPositiveIds, pageSize: PAGE_SIZE };
}

/**
 * The answers of one screen's requests, started together just before this
 * call. The main page is awaited until its own deadline; each optional source
 * (the follows, exploration) holds the screen for its budget at most, counted
 * from this call, and gives no papers when it fails or runs out. On a first
 * screen (`firstScreen`, waitsAsFirstScreen) an answer that arrived after its
 * budget but while the main page was awaited is kept, since the reader waited
 * for it anyway (ENG-116); a refresh over shown cards and a next page leave it
 * out. An optional source's failure is handled from this call, so one that
 * fails while the main page is awaited is not reported as an unhandled
 * rejection.
 */
export async function awaitScreenSources<T, O>(main: PromiseLike<T>, optional: Array<{ answer: PromiseLike<O[]>; budgetMs: number }>, firstScreen: boolean) {
  const startedAt = Date.now();
  const optionalAnswers = optional.map(({ answer, budgetMs }) => {
    const papers = Promise.resolve(answer).then(answered => answered, () => [] as O[]);
    return { papers, onTime: firstScreen ? null : resolveWithin(papers, budgetMs, [] as O[]), budgetMs };
  });
  const mainAnswer = await Promise.resolve(main).then(value => ({ value }), (error: unknown) => ({ error }));
  const waited = Date.now() - startedAt;
  const optionalPapers = await Promise.all(optionalAnswers.map(({ papers, onTime, budgetMs }) => onTime ?? resolveWithin(papers, budgetMs - waited, [] as O[])));
  return { main: mainAnswer, optional: optionalPapers };
}

/**
 * The reader's follows, ranked by the plan's examples: neither a follow nor
 * the memory of an area the reader left orders the rest of the page. A topic
 * follow that is one of the app's categories is asked for as those categories
 * here only, so it fills the follows' places and no others.
 */
export function followedCorpusRequest(plan: FeedPlan, followedEntities: FollowEntity[], categoryIdsOf: (follow: FollowEntity) => string[], shared: SharedRequest) {
  const categoryFollows = followedEntities
    .map(follow => ({ follow, categoryIds: follow.type === 'topic' ? categoryIdsOf(follow) : [] }))
    .filter(entry => entry.categoryIds.length > 0);
  const request: CorpusPageRequest = {
    ...shared,
    categories: [...new Set(categoryFollows.flatMap(entry => entry.categoryIds))],
    follows: followedEntities,
    positiveIds: plan.positiveIds,
    pageSize: FOLLOWED_PER_PAGE,
  };
  return { request, categoryFollows };
}
