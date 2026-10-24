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
  // The papers the reader has seen, sent with `skipsSeen`: a Worker that skips
  // them answers with the next papers of the reader's ranking they have not
  // seen, whatever `page` says, and says `skipsSeen` too. With it, how many
  // notable papers of its categories the page may add after its own: only
  // unseen ones, for the app to place (placeNotableCards).
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
  const { papers, skipsSeen } = await response.json() as { papers?: Paper[]; skipsSeen?: unknown };
  return { papers: Array.isArray(papers) ? papers : [], skipsSeen: skipsSeen === true };
}

/**
 * A page of the paper corpus (worker/paper-store.ts): every source the feed
 * reads, harvested, merged and enriched once a day in the Worker, here ranked
 * by the reader's liked and saved papers. Categories are the app's; follows
 * are sent as they are stored, and the Worker decides how each is served.
 * Each paper says which asked categories (`_fetchedFor`) and follows
 * (`_followedEntityMatches`) it was found under, and a notable one `_notable`.
 * `skipsSeen` says the Worker passed over the papers in `seen`; Workers
 * before it page by number. A request asks for it explicitly, so a Worker
 * that skips seen papers pages by number for bundles that send `seen` only
 * for notable papers.
 */
export function fetchCorpusPage({ categories = [], follows = [], positiveIds = [], page, pageSize, order = 'recent', seen, notable = 0, waitForLikes = false }: CorpusPageRequest, options: StoreOptions = {}) {
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
    ...(seen ? { seen: feedSeenFilter(seen), skipsSeen: true, ...(notable > 0 ? { notable } : {}) } : {}),
    ...(waitForLikes ? { waitForLikes } : {}),
  }, options);
}

/**
 * The corpus's copies of these papers, by the ids the app holds for them,
 * with what the corpus's enrichment added. A paper the corpus lacks is fetched
 * into it when its id names a source it can ask; otherwise it is left out.
 */
export async function fetchCorpusPapers(ids: string[], options: StoreOptions = {}) {
  return (await askStore({ ids }, options)).papers;
}
