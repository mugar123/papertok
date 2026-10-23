import type { Paper } from '../models/Paper.ts';
import type { FollowEntity } from '../utils/following.ts';

import { authenticatedWorkerFetch, workerSourceUrl } from './workerApiClient.ts';
import { feedSeenFilter } from '../utils/seenPaperFilter.ts';

// Inside the feed's 4 s first-paint budget, with room for the response.
const STORE_TIMEOUT_MS = 3_500;

export interface CorpusPageRequest {
  categories?: string[];
  follows?: FollowEntity[];
  positiveIds?: string[];
  page: number;
  pageSize: number;
  order?: string;
  // The papers the reader has seen. Only a page that says gets notable papers
  // of its categories, and only ones the reader has not seen.
  seen?: Iterable<string>;
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
 * (`_followedEntityMatches`) it was found under, and a notable one `_notable`.
 */
export function fetchCorpusPage({ categories = [], follows = [], positiveIds = [], page, pageSize, order = 'recent', seen }: CorpusPageRequest, options: StoreOptions = {}) {
  return askStore({
    categories,
    follows: follows.map(({ type, canonicalId, displayName, metadata }) => ({
      type,
      canonicalId,
      displayName,
      metadata: { query: metadata?.query, funder: metadata?.funder },
    })),
    positiveIds,
    page,
    pageSize,
    order,
    ...(seen ? { seen: feedSeenFilter(seen) } : {}),
  }, options);
}

/**
 * The corpus's copies of these papers, by the ids the app holds for them,
 * with what the corpus's enrichment added. A paper the corpus lacks is fetched
 * into it when its id names a source it can ask; otherwise it is left out.
 */
export function fetchCorpusPapers(ids: string[], options: StoreOptions = {}) {
  return askStore({ ids }, options);
}
