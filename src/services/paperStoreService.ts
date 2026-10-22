import type { Paper } from '../models/Paper.ts';

import { fetchPapers } from './arxivService.ts';
import { arxivPaper, isArxivCategory } from './arxivRecords.ts';
import { authenticatedWorkerFetch, hasWorkerSession, workerSourceUrl } from './workerApiClient.ts';

// Short enough that the live fallback below can still answer inside the
// feed's 4 s first-paint budget when the store is healthy but slow.
const STORE_FEED_TIMEOUT_MS = 2_500;

interface StoreFeedPaper {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  doi: string | null;
  journalRef: string | null;
  comments: string | null;
  published: string;
}

interface StoreFeedOptions {
  fetchWorker?: (url: string, init: RequestInit) => Promise<Response>;
  fetchLive?: typeof fetchPapers;
  hasSession?: () => boolean;
  apiBase?: string;
}

/**
 * The feed's arXiv papers from the Worker's paper store (worker/paper-store.ts):
 * a page in the reader's arXiv categories, closest to their liked and saved
 * papers first. arXiv itself still answers for relevance order, which reaches
 * further back than the store, for categories arXiv does not have
 * (engineering), for a reader without a session, and when the store fails or
 * has nothing for the page.
 */
export async function fetchStoreFeed(
  categories: string[],
  page: number,
  pageSize: number,
  queryMode: string,
  positiveIds: string[],
  { fetchWorker = authenticatedWorkerFetch, fetchLive = fetchPapers, hasSession = hasWorkerSession, apiBase }: StoreFeedOptions = {},
): Promise<Paper[]> {
  const live = (asked: string[]) => fetchLive(asked, page * pageSize, pageSize, queryMode);
  if (queryMode === 'relevance' || !hasSession()) return live(categories);
  const storeCategories = categories.filter(isArxivCategory);
  const labelCategories = categories.filter(category => !isArxivCategory(category));
  const fromStore = async () => {
    try {
      const papers = await fetchStorePage(fetchWorker, apiBase, storeCategories, page, pageSize, positiveIds);
      if (papers.length > 0) return papers;
    } catch (error) {
      console.warn('Paper store unavailable; asking arXiv', error);
    }
    return live(storeCategories);
  };
  const [stored, searched] = await Promise.all([
    storeCategories.length ? fromStore() : [],
    labelCategories.length ? live(labelCategories) : [],
  ]);
  return [...stored, ...searched];
}

async function fetchStorePage(
  fetchWorker: NonNullable<StoreFeedOptions['fetchWorker']>,
  apiBase: string | undefined,
  categories: string[],
  page: number,
  pageSize: number,
  positiveIds: string[],
) {
  const response = await fetchWorker(workerSourceUrl('/store/feed', {}, apiBase), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ categories, page, pageSize, positiveIds }),
    signal: AbortSignal.timeout(STORE_FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Paper store returned ${response.status}`);
  const { papers } = await response.json() as { papers: StoreFeedPaper[] };
  return papers.map(paper => arxivPaper({
    arxivId: paper.arxivId,
    title: paper.title,
    abstract: paper.abstract,
    authors: paper.authors,
    doi: paper.doi || '',
    journalRef: paper.journalRef || '',
    comment: paper.comments || '',
    published: paper.published,
    allCategories: paper.categories,
    primaryCategory: paper.categories[0],
  }));
}
