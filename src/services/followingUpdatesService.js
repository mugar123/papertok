import { fetchPapers, fetchPapersByIds, getAuthorPapers } from './arxivService';
import { fetchPapersByDois, getWorksByEntity } from './openAlexService';
import { getPapersByProject } from './openAireService';
import {
  isRecentFollowingUpdate,
  mergeFollowingUpdatePapers,
} from '../utils/followingUpdates';

const PAPERS_PER_ENTITY = 5;
const MAX_FOLLOWS_PER_REFRESH = 40;

function createMatch(follow) {
  return {
    type: follow.type,
    canonicalId: follow.canonicalId,
    displayName: follow.displayName,
  };
}

function withMatch(papers, follow) {
  const match = createMatch(follow);
  return (papers || []).slice(0, PAPERS_PER_ENTITY).map(paper => ({
    ...paper,
    _followedEntityMatches: [match],
  }));
}

function cleanOpenAlexId(value) {
  return String(value || '').split('/').pop();
}

async function fetchTopicUpdates(follow) {
  const categoryIds = follow.metadata?.categoryIds || [];
  const candidates = [follow.canonicalId, ...categoryIds].filter(Boolean);
  const openAlexId = candidates.map(cleanOpenAlexId).find(id => /^[TC]\d+$/i.test(id));

  if (openAlexId) {
    const entityType = openAlexId.toUpperCase().startsWith('T') ? 'topic' : 'concept';
    const result = await getWorksByEntity(entityType, openAlexId, 'publication_date:desc', 1);
    return result.papers || [];
  }

  const arxivCategory = candidates.find(value => /^[a-z-]+(?:\.[A-Z-]+)?$/i.test(String(value)));
  return fetchPapers([arxivCategory || follow.displayName], 0, PAPERS_PER_ENTITY, 'recent');
}

async function fetchAuthorUpdates(follow) {
  const authorId = cleanOpenAlexId(follow.canonicalId);
  if (/^A\d+$/i.test(authorId)) {
    const result = await getWorksByEntity('author', authorId, 'publication_date:desc', 1);
    return result.papers || [];
  }
  return getAuthorPapers(follow.displayName, PAPERS_PER_ENTITY);
}

async function fetchInstitutionUpdates(follow) {
  const institutionId = follow.externalIds?.ror || follow.canonicalId;
  const result = await getWorksByEntity(
    'institution',
    institutionId,
    'publication_date:desc',
    1,
    '',
    {},
    follow.displayName,
  );
  return result.papers || [];
}

async function fetchProjectUpdates(follow) {
  const result = await getPapersByProject(follow.canonicalId, 1);
  const [arxivResult, doiResult] = await Promise.allSettled([
    fetchPapersByIds((result.arxivIds || []).slice(0, PAPERS_PER_ENTITY)),
    fetchPapersByDois((result.dois || []).slice(0, PAPERS_PER_ENTITY)),
  ]);
  return [
    ...(arxivResult.status === 'fulfilled' ? arxivResult.value : []),
    ...(doiResult.status === 'fulfilled' ? doiResult.value : []),
  ];
}

async function fetchUpdatesForFollow(follow) {
  if (follow.type === 'topic') return fetchTopicUpdates(follow);
  if (follow.type === 'author') return fetchAuthorUpdates(follow);
  if (follow.type === 'institution') return fetchInstitutionUpdates(follow);
  if (follow.type === 'project') return fetchProjectUpdates(follow);
  return [];
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function fetchFollowingUpdates(followedEntities = [], options = {}) {
  const follows = followedEntities.slice(0, MAX_FOLLOWS_PER_REFRESH);
  const settled = await mapWithConcurrency(follows, 4, async (follow) => (
    withMatch(await fetchUpdatesForFollow(follow), follow)
  ));

  const papers = settled
    .filter(result => result.status === 'fulfilled')
    .flatMap(result => result.value)
    .filter(paper => isRecentFollowingUpdate(paper, options.now, options.maxAgeDays || 365));

  return {
    papers: mergeFollowingUpdatePapers(papers, options.limit || 60),
    checkedEntities: follows.length,
    totalEntities: followedEntities.length,
    failedEntities: settled.filter(result => result.status === 'rejected').length,
  };
}
