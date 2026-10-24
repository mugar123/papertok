import type { Paper } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';

import { authenticatedWorkerFetch, workerSourceUrl } from './worker-api-client.ts';

// Inside the feed's 4 s first-paint budget, with room for the response.
const STORE_TIMEOUT_MS = 3_500;

export interface CorpusPageRequest {
  categories?: string[];
  follows?: FollowEntity[];
  positiveIds?: string[];
  negativeIds?: string[];
  excludedIds?: string[];
  page: number;
  pageSize: number;
  order?: string;
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
 * A page of the paper corpus (worker/paper-store.ts): every source the feed
 * reads, harvested, merged and enriched once a day in the Worker, here ranked
 * by the reader's liked and saved papers. Categories are the app's; follows
 * are sent as they are stored, and the Worker decides how each is served.
 * Each paper says which asked categories (`_fetchedFor`) and follows
 * (`_followedEntityMatches`) it was found under.
 */
export function fetchCorpusPage({ categories = [], follows = [], positiveIds = [], negativeIds = [], excludedIds = [], page, pageSize, order = 'recent', waitForLikes = false }: CorpusPageRequest, options: StoreOptions = {}) {
  const body = {
    categories,
    follows: follows.map(({ type, canonicalId, displayName, metadata }) => ({
      type,
      canonicalId,
      displayName,
      metadata: { query: metadata?.query, funder: metadata?.funder },
    })),
    positiveIds,
    ...(negativeIds.length ? { negativeIds: negativeIds.slice(0, 24) } : {}),
    excludedIds: [...new Set(excludedIds)].slice(0, 200),
    page,
    pageSize,
    order,
    ...(waitForLikes ? { waitForLikes } : {}),
  };
  while (body.excludedIds.length && new TextEncoder().encode(JSON.stringify(body.excludedIds)).byteLength > 6_000) body.excludedIds.pop();
  // Trim new signals before they can push the existing request over 16 KiB.
  // Trim rejections first so the exclusion snapshot stays stable as they change.
  while (new TextEncoder().encode(JSON.stringify(body)).byteLength > 16_000) {
    if (body.negativeIds?.length) body.negativeIds.pop();
    else if (body.excludedIds.length) body.excludedIds.pop();
    else break;
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
