import type { CorpusPageRequest } from '../services/paper-store-service.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { InterestGroup, InterestMemoryInput } from '../utils/interest-memory.ts';

import { corpusPositiveIds } from '../services/paper-store-service.ts';
import { activeCategories, interestProgress, planInterestGroups } from '../utils/interest-memory.ts';
import { PAGE_SIZE } from './feed-pagination.ts';

// How many papers the followed entities add to a page.
export const FOLLOWED_PER_PAGE = 6;

/**
 * What the pages of one For You list rank by (ENG-137): the reader's interest
 * groups, every example they rank by, the active subareas and how far the app
 * has learned each interest. The scoring of the list's cards reads the last
 * two, so they hold still with the groups.
 */
export interface FeedPlan {
  groups: InterestGroup[];
  unassignedPositiveIds: string[];
  positiveIds: string[];
  activeCategories: string[];
  interestProgress: Record<string, number>;
}

type SharedRequest = Pick<CorpusPageRequest, 'page' | 'order' | 'negativeIds' | 'excludedIds'>;

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
    activeCategories: [...activeCategories(input.selected, input.deselected)],
    interestProgress: interestProgress(input),
  };
}

/** The reader's interests, asked by group. */
export function mainCorpusRequest(plan: FeedPlan, shared: SharedRequest): CorpusPageRequest {
  return { ...shared, groups: plan.groups, positiveIds: plan.unassignedPositiveIds, pageSize: PAGE_SIZE };
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
