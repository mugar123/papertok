import type { Paper } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { InterestGroup } from '../utils/interest-memory.ts';

import { authenticatedWorkerFetch, workerSourceUrl } from './worker-api-client.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from '../utils/feed-interactions.ts';
import { feedSeenFilter } from '../utils/seen-paper-filter.ts';

// Inside the feed's 4 s first-paint budget, with room for the response.
const STORE_TIMEOUT_MS = 3_500;

export interface CorpusPageRequest {
  categories?: string[];
  /**
   * The reader's interest groups (planInterestGroups), each ranked by its own
   * examples. With them, `categories` is their union and `positiveIds` names
   * only the examples of no group.
   */
  groups?: InterestGroup[];
  follows?: FollowEntity[];
  positiveIds?: string[];
  negativeIds?: string[];
  excludedIds?: string[];
  page: number;
  pageSize: number;
  order?: string;
  // The papers the reader has seen, and how many notable papers of its
  // categories the page may add after its own: only ones the reader has not
  // seen, for the app to place (placeNotableCards). Sent only together.
  seen?: Iterable<string>;
  notable?: number;
  /**
   * Rank by the likes only once the corpus has fetched and embedded the ones
   * it lacks, which can take seconds: for More like this, never a feed page.
   */
  waitForLikes?: boolean;
}

interface StoreOptions {
  fetchWorker?: (url: string, init: RequestInit) => Promise<Response>;
  apiBase?: string;
}

async function askStore(body: unknown, { fetchWorker = authenticatedWorkerFetch, apiBase }: StoreOptions) {
  const response = await fetchWorker(workerSourceUrl('/store/papers', {}, apiBase), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Paper store returned ${response.status}`);
  const { papers } = await response.json() as { papers?: Paper[] };
  return Array.isArray(papers) ? papers : [];
}

/**
 * The groups' examples, then the ones of no group, as one request ranks by
 * them: what a Worker that reads no groups ranks by.
 */
export function corpusPositiveIds(groups: InterestGroup[], positiveIds: string[]) {
  return [...new Set([...groups.flatMap(group => group.positiveIds), ...positiveIds])].slice(0, SEMANTIC_PROFILE_POSITIVE_CAP);
}

/**
 * A page of the paper corpus (worker/paper-store.ts): every source the feed
 * reads, harvested, merged and enriched once a day in the Worker, here ranked
 * by the reader's examples (likes, saves and long reads) per interest group.
 * Categories are the app's; follows are sent as they are stored, and the
 * Worker decides how each is served.
 * Each paper says which asked categories (`_fetchedFor`) and follows
 * (`_followedEntityMatches`) it was found under, and a notable one `_notable`.
 */
export function fetchCorpusPage({ categories = [], groups, follows = [], positiveIds = [], negativeIds = [], excludedIds = [], page, pageSize, order = 'recent', seen, notable = 0, waitForLikes = false }: CorpusPageRequest, options: StoreOptions = {}) {
  const body = {
    categories: groups ? [...new Set(groups.flatMap(group => group.categories))] : categories,
    follows: follows.map(({ type, canonicalId, displayName, metadata }) => ({
      type,
      canonicalId,
      displayName,
      metadata: { query: metadata?.query, funder: metadata?.funder },
    })),
    positiveIds: groups ? corpusPositiveIds(groups, positiveIds) : positiveIds,
    // Copies: the examples below may be trimmed, and the plan is the feed's.
    ...(groups ? { groups: groups.map(group => ({ ...group, positiveIds: [...group.positiveIds] })) } : {}),
    ...(negativeIds.length ? { negativeIds: negativeIds.slice(0, 24) } : {}),
    excludedIds: [...new Set(excludedIds)].slice(0, 200),
    page,
    pageSize,
    order,
    ...(seen && notable > 0 ? { seen: feedSeenFilter(seen), notable } : {}),
    ...(waitForLikes ? { waitForLikes } : {}),
  };
  while (body.excludedIds.length && new TextEncoder().encode(JSON.stringify(body.excludedIds)).byteLength > 6_000) body.excludedIds.pop();
  // Trim new signals before they can push the existing request over 16 KiB.
  // Trim rejections first so the exclusion snapshot stays stable as they change.
  // A grouped request carries each example twice, so with long ids it can
  // still be over. Then examples go: first those of no group, then the oldest
  // of the group holding the most, so each group keeps its newest longest.
  // An example leaves the flat list and every group together, so both rank by
  // the same ones.
  while (new TextEncoder().encode(JSON.stringify(body)).byteLength > 16_000) {
    if (body.negativeIds?.length) body.negativeIds.pop();
    else if (body.excludedIds.length) body.excludedIds.pop();
    else if (body.groups && body.positiveIds.length) {
      const grouped = new Set(body.groups.flatMap(group => group.positiveIds));
      const largest = body.groups.reduce((most, group) => (group.positiveIds.length > most.positiveIds.length ? group : most));
      const dropped = body.positiveIds.findLast(id => !grouped.has(id)) ?? largest.positiveIds.at(-1);
      body.positiveIds = body.positiveIds.filter(id => id !== dropped);
      for (const group of body.groups) group.positiveIds = group.positiveIds.filter(id => id !== dropped);
    } else break;
  }
  return askStore({ ...body, ...(body.excludedIds.length ? {} : { excludedIds: undefined }) }, options);
}

/**
 * The corpus's copies of these papers, by the ids the app holds for them,
 * with what the corpus's enrichment added. A paper the corpus lacks is fetched
 * into it when its id names a source it can ask; otherwise it is left out.
 */
export function fetchCorpusPapers(ids: string[], options: StoreOptions = {}) {
  return askStore({ ids }, options);
}
