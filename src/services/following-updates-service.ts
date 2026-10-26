import type { Paper } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { fetchTopicPapers } from './topic-retrieval-service.ts';
type TopicRetriever = (...args: Parameters<typeof fetchTopicPapers>) => Promise<Pick<Awaited<ReturnType<typeof fetchTopicPapers>>, 'papers' | 'allFailed'>>;
interface FollowingResult { papers: Paper[]; checkedEntities: number; totalEntities: number; failedEntities: number; }
interface FollowingOptions {
  topicRetriever?: TopicRetriever; fetchUpdatesForFollow?: (follow: FollowEntity, options: FollowingOptions) => Promise<Paper[]>;
  entityTimeoutMs?: number; limit?: number; maxAgeDays?: number; now?: number; onProgress?: (result: FollowingResult) => void;
}

import { mapWithConcurrency } from '../utils/map-with-concurrency.ts';
import { settleWithin } from '../utils/async-timing.ts';
import { isScientificCategoryId } from '../utils/topic-navigation.ts';
import { fetchPapersByIds, getAuthorPapers } from './arxiv-service.ts';
import { fetchPapersByDois, getWorksByEntity } from './open-alex-service.ts';
import { getPapersByProject } from './open-aire-service.ts';
import {
  isRecentFollowingUpdate,
  mergeFollowingUpdatePapers,
} from '../utils/following-updates.ts';

const PAPERS_PER_ENTITY = 5;
const MAX_FOLLOWS_PER_REFRESH = 40;
// A follow whose source has stalled must not hold the whole refresh: the
// cache is only written, and `lastUpdatedAt` only set, once every follow has
// settled. A safety net, not a scheduler: arXiv requests wait their turn in
// one chain shared with the feed (arxivService), and measured, a follow's
// request sat behind two stalled feed queries for 20 s and still answered —
// a 20 s deadline dropped it a second before it did. Only a follow the chain
// has not reached in 45 s is given up on, and the next refresh asks again.
const ENTITY_DEADLINE_MS = 45_000;
// A category topic in the inbox asks for what is new in the category — the
// exact `cat:` query on arXiv, plus the domain sources — not for what matches
// its name. The phrase searches on arXiv and PubMed answer by relevance, mostly
// duplicate or miss the category, and the arXiv one costs a place in the
// serialized arXiv chain (arxivService), which is the critical path of a
// refresh: measured with fourteen follows, every arXiv request waited ~0.6–1 s
// for its turn and the last one went out 6 s in.
const CATEGORY_TOPIC_EXCLUDED_PROVIDERS = Object.freeze(['searchArxiv', 'searchPubmed']);

function createMatch(follow: FollowEntity) {
  return {
    type: follow.type,
    canonicalId: follow.canonicalId,
    displayName: follow.displayName,
    source: follow.source,
    externalIds: { ...(follow.externalIds || {}) },
    metadata: { ...(follow.metadata || {}) },
  };
}

function withMatch(papers: Paper[], follow: FollowEntity) {
  const match = createMatch(follow);
  return (papers || []).slice(0, PAPERS_PER_ENTITY).map(paper => ({
    ...paper,
    _followedEntityMatches: [match],
  }));
}

function cleanOpenAlexId(value: unknown) {
  return String(value || '').split('/').pop()!;
}

function topicUpdatesOptions(follow: FollowEntity) {
  const canonicalId = cleanOpenAlexId(follow?.canonicalId);
  if (/^[TC]\d+$/i.test(canonicalId)) return {};
  const categoryIds = follow?.metadata?.categoryIds || follow?.categoryIds;
  const byCategory = (Array.isArray(categoryIds) && categoryIds.length > 0) || isScientificCategoryId(canonicalId);
  return byCategory ? { excludeProviders: [...CATEGORY_TOPIC_EXCLUDED_PROVIDERS] } : {};
}

async function fetchTopicUpdates(follow: FollowEntity, topicRetriever?: TopicRetriever) {
  // The topic table is ~32 KB gzip and this runs on a background refresh, so
  // the module loads on first use instead of in the boot graph. Tests still
  // inject their own retriever through the parameter.
  const retrieve = topicRetriever
    || (await import('./topic-retrieval-service.ts')).fetchTopicPapers;
  const result = await retrieve(follow, {
    allowLegacyDisplayName: true,
    maxPapers: PAPERS_PER_ENTITY,
    mode: 'recent',
    page: 1,
    pageSize: PAPERS_PER_ENTITY,
    sortBy: 'publication_date:desc',
    ...topicUpdatesOptions(follow),
  });
  if (result.allFailed) throw new Error('All topic providers failed.');
  return result.papers;
}

async function fetchAuthorUpdates(follow: FollowEntity) {
  const authorId = cleanOpenAlexId(follow.canonicalId);
  if (/^A\d+$/i.test(authorId)) {
    const result = await getWorksByEntity('author', authorId, 'publication_date:desc', 1);
    return result.papers || [];
  }
  return getAuthorPapers(follow.displayName, PAPERS_PER_ENTITY);
}

async function fetchInstitutionUpdates(follow: FollowEntity) {
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

// A followed journal's newest articles (ENG-123, D7): fetched live like the
// other follows, though the journal's lane in the corpus holds them too.
async function fetchJournalUpdates(follow: FollowEntity) {
  const result = await getWorksByEntity('journal', follow.canonicalId, 'publication_date:desc', 1);
  return result.papers || [];
}

async function fetchProjectUpdates(follow: FollowEntity) {
  // A bare grant code answers for every funder that ever used it
  // (code 100010 is three projects), and that is the shape of every
  // project followed before the OpenAIRE id landed. The funder stored on the
  // follow is what narrows it; documents written before it was stored carry
  // none, and for those this is the empty default it always had.
  const result = await getPapersByProject(follow.canonicalId, 1, { funder: follow.metadata?.funder || '' });
  const [arxivResult, doiResult] = await Promise.allSettled([
    fetchPapersByIds((result.arxivIds || []).slice(0, PAPERS_PER_ENTITY)),
    fetchPapersByDois((result.dois || []).slice(0, PAPERS_PER_ENTITY)),
  ]);
  return [
    ...(arxivResult.status === 'fulfilled' ? arxivResult.value : []),
    ...(doiResult.status === 'fulfilled' ? doiResult.value : []),
  ];
}

async function fetchUpdatesForFollow(follow: FollowEntity, options: FollowingOptions = {}) {
  if (follow.type === 'topic') return fetchTopicUpdates(follow, options.topicRetriever);
  if (follow.type === 'author') return fetchAuthorUpdates(follow);
  if (follow.type === 'institution') return fetchInstitutionUpdates(follow);
  if (follow.type === 'project') return fetchProjectUpdates(follow);
  if (follow.type === 'journal') return fetchJournalUpdates(follow);
  return [];
}

// Whether a follow resolves through OpenAlex alone — one request, answered in
// parallel through the Worker — or through the arXiv chain, where every
// request waits its turn (authors by name, topics by category, a project's
// arXiv ids). Fast first, so the first delivery below comes from the follows
// that can answer at once.
function resolvesThroughOpenAlex(follow: FollowEntity) {
  const id = cleanOpenAlexId(follow?.canonicalId);
  if (follow?.type === 'author') return /^A\d+$/i.test(id);
  if (follow?.type === 'topic') return /^[TC]\d+$/i.test(id);
  return follow?.type === 'institution' || follow?.type === 'journal';
}

export function orderFollowsForRefresh(follows: FollowEntity[] = []) {
  const fast: FollowEntity[] = [];
  const slow: FollowEntity[] = [];
  follows.forEach(follow => (resolvesThroughOpenAlex(follow) ? fast : slow).push(follow));
  return [...fast, ...slow];
}

/**
 * The recent papers of everything followed, delivered as they arrive.
 *
 * `options.onProgress` is called after every follow settles, with the same
 * shape the promise resolves to — the papers merged so far and the counters —
 * so the page can paint the first follow's answer while the arXiv chain is
 * still working through the rest. Measured with fourteen follows on a cold
 * cache: the first answer was in at ~300 ms, the last at 6.5 s, and the feed
 * used to wait for the last. The final value is the last delivery.
 */
export async function fetchFollowingUpdates(followedEntities: FollowEntity[] = [], options: FollowingOptions = {}): Promise<FollowingResult> {
  const follows = orderFollowsForRefresh(followedEntities.slice(0, MAX_FOLLOWS_PER_REFRESH));
  const fetchOne = options.fetchUpdatesForFollow || fetchUpdatesForFollow;
  const deadlineMs = Number.isFinite(options.entityTimeoutMs) ? options.entityTimeoutMs : ENTITY_DEADLINE_MS;
  const limit = options.limit || 60;
  const maxAgeDays = options.maxAgeDays || 365;
  const collected: Paper[] = [];
  let checkedEntities = 0;
  let failedEntities = 0;

  const deliver = () => ({
    papers: mergeFollowingUpdatePapers(
      collected.filter(paper => isRecentFollowingUpdate(paper, options.now, maxAgeDays)),
      limit,
    ),
    checkedEntities,
    totalEntities: followedEntities.length,
    failedEntities,
  });

  await mapWithConcurrency(follows, 4, async (follow) => {
    const settled = await settleWithin(Promise.resolve().then(() => fetchOne(follow, options)), deadlineMs!);
    checkedEntities += 1;
    if (settled.status === 'fulfilled') collected.push(...withMatch(settled.value, follow));
    else failedEntities += 1;
    if (typeof options.onProgress === 'function') {
      try {
        options.onProgress(deliver());
      } catch (progressError) {
        console.warn('Following progress handler failed', progressError);
      }
    }
  });

  return deliver();
}
