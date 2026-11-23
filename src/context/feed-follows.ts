import type { Paper, PaperFollowMatch } from '../models/paper.ts';
import type { followedCorpusRequest } from './feed-corpus-requests.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';

/**
 * The Worker serves followed entities from the lanes it harvests for them
 * and reports which follows matched each paper. A followed area's search
 * lane uses its English taxonomy label. The app also matches `_fetchedFor`
 * against a followed leaf's ID or up to 12 leaves per followed area.
 * With `seen`, a Worker that skips seen papers sends the follows' next unseen ones.
 */
export async function fetchFollowedEntityCandidates({ request, categoryFollows }: ReturnType<typeof followedCorpusRequest>, options?: Parameters<typeof fetchCorpusPage>[1]) {
  const { papers } = await fetchCorpusPage(request, options);
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
