import type { Paper, PaperFollowMatch } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';

// How many papers the followed entities add to a page.
export const FOLLOWED_PER_PAGE = 6;

/**
 * Papers of the reader's follows from the paper corpus: the Worker serves an
 * author, institution, OpenAlex topic, project or followed query from the
 * lane it harvests for it, and says which follows each paper matched. A
 * topic follow that is one of the app's categories is asked for as those
 * categories, and matched by the categories a paper was found under. With
 * `seen`, a Worker that skips seen papers sends the follows' next unseen ones.
 */
export async function fetchFollowedEntityCandidates(followedEntities: FollowEntity[], { page, order, positiveIds, negativeIds, excludedIds, seen, categoryIdsOf }: {
  page: number; order: string; positiveIds: string[]; negativeIds: string[]; excludedIds: string[]; seen?: Iterable<string>; categoryIdsOf: (follow: FollowEntity) => string[];
}, options?: Parameters<typeof fetchCorpusPage>[1]) {
  const categoryFollows = followedEntities
    .map(follow => ({ follow, categoryIds: follow.type === 'topic' ? categoryIdsOf(follow) : [] }))
    .filter(entry => entry.categoryIds.length > 0);
  const { papers } = await fetchCorpusPage({
    categories: [...new Set(categoryFollows.flatMap(entry => entry.categoryIds))],
    follows: followedEntities,
    positiveIds,
    negativeIds,
    excludedIds,
    page,
    pageSize: FOLLOWED_PER_PAGE,
    order,
    seen,
  }, options);
  return papers.map(paper => ({
    ...paper,
    _type: 'followed' as const,
    _followedEntityMatches: mergeFollowEntityMatches(
      paper._followedEntityMatches,
      categoryFollows.filter(entry => entry.categoryIds.some(id => paper._fetchedFor?.includes(id))).map(entry => entry.follow),
    ),
  }));
}

/** The follows of `groups` together, each entity once. */
export function mergeFollowEntityMatches(...groups: Array<Paper['_followedEntityMatches']>) {
  const matches = groups.flat().filter(match => match && typeof match === 'object') as PaperFollowMatch[];
  return matches.filter((match, index) => matches.findIndex(candidate => (
    candidate.type === match.type && candidate.canonicalId === match.canonicalId
  )) === index);
}
