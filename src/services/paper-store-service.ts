import type { Paper } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { InterestGroup } from '../utils/interest-memory.ts';

import { authenticatedWorkerFetch, sourceResponseError, workerSourceUrl } from './worker-api-client.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from '../utils/feed-interactions.ts';
import { feedSeenFilter } from '../utils/seen-paper-filter.ts';
import { FEED_MAX_FOLLOWS, followLane } from '../utils/follow-lanes.ts';

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
  // The papers the reader has seen (`feedSeenIds`), sent with `skipsSeen`: a
  // Worker that skips them answers with the next papers of the reader's
  // ranking they have not seen, whatever `page` says, and says `skipsSeen`
  // too. With it, how many notable papers of its categories the page may add
  // after its own: only unseen ones, for the app to place (placeNotableCards).
  seen?: Iterable<string>;
  notable?: number;
  // With `seen`, a first page goes on with the walk of the order the Worker
  // kept for the same request (continuesWalk in src/context/feed-pagination.ts).
  continues?: boolean;
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

// fetch, and reading its body, reject with a TypeError when the connection
// fails. Marked where the transfer fails, so a TypeError from code is not taken for it.
function markUnreachable(error: unknown): never {
  if (error instanceof TypeError) throw Object.assign(new Error('The paper store could not be reached', { cause: error }), { code: 'STORE_UNREACHABLE' });
  throw error;
}

async function askStore(body: unknown, { fetchWorker = authenticatedWorkerFetch, apiBase }: StoreOptions) {
  const response = await fetchWorker(workerSourceUrl('/store/papers', {}, apiBase), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
  }).catch(markUnreachable);
  if (!response.ok) {
    // The Worker's `code` says why it refused (worker/router.ts); a body that
    // is not JSON, such as a gateway's page, leaves the status alone.
    const refusal = await response.json().catch(() => null) as { code?: unknown } | null;
    throw sourceResponseError('/store/papers', response.status, refusal);
  }
  const answer = await response.json().catch(markUnreachable) as { papers?: Paper[]; skipsSeen?: unknown } | null;
  // The Worker always answers a list, empty when nothing matches.
  const papers = answer?.papers;
  if (!Array.isArray(papers)) throw Object.assign(new Error('/store/papers answered without a papers list'), { code: 'STORE_RESPONSE_INVALID' });
  return { papers, skipsSeen: answer?.skipsSeen === true };
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
 * Categories are the app's; the follows the Worker reads are sent as they are
 * stored, and the Worker decides how each is served.
 * Each paper says which asked categories (`_fetchedFor`) and follows
 * (`_followedEntityMatches`) it was found under, and a notable one `_notable`.
 * `skipsSeen` says the Worker passed over the papers in `seen`; Workers
 * before it page by number. A request asks for it explicitly, so a Worker
 * that skips seen papers pages by number for bundles that send `seen` only
 * for notable papers.
 */
export function fetchCorpusPage({ categories = [], groups, follows = [], positiveIds = [], negativeIds = [], excludedIds = [], page, pageSize, order = 'recent', seen, notable = 0, continues = false, waitForLikes = false }: CorpusPageRequest, options: StoreOptions = {}) {
  const read = follows.filter(follow => followLane(follow)).slice(0, FEED_MAX_FOLLOWS);
  const body = {
    categories: groups ? [...new Set(groups.flatMap(group => group.categories))] : categories,
    // Only the follows the Worker reads travel (`parseFeedRequest`): the first
    // FEED_MAX_FOLLOWS with a lane. A topic follow that is one of the app's
    // categories has none; it is asked for as that category. When no follow
    // has a lane, the first still travels, so the request stays the follows'
    // page: the Worker reads no area lane for it, and answers it with no
    // papers when it has no categories either (`handleCorpusFeed`).
    follows: (read.length ? read : follows.slice(0, 1)).map(({ type, canonicalId, displayName, metadata }) => ({
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
    ...(seen ? { seen: feedSeenFilter(seen), skipsSeen: true, ...(notable > 0 ? { notable } : {}), ...(continues ? { continues } : {}) } : {}),
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
export async function fetchCorpusPapers(ids: string[], options: StoreOptions = {}) {
  return (await askStore({ ids }, options)).papers;
}
