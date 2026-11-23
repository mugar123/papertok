import type { Paper } from '../models/paper.ts';
import type { parsePaperKey } from '../utils/public-navigation.ts';
import type { OpenReviewNote } from './open-review-service.ts';

import { fetchPapersByIds } from './arxiv-service.ts';
import {
  enrichPapersBatch,
  fetchPaperByArxivIdViaOpenAlex,
  fetchPaperByWorkId,
  hasCachedEnrichment,
} from './open-alex-service.ts';
import { mapOpenReviewNote } from './open-review-service.ts';
import { fetchWorkerSourceJson } from './worker-api-client.ts';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
} from '../utils/feed-enrichment.ts';

/**
 * The submission an OpenReview forum id names, through the Worker
 * (`/sources/openreview?id=`). Null when OpenReview has no such submission; a
 * provider failure rejects. `options` is `fetchWorkerSourceJson`'s own seam.
 */
export async function fetchOpenReviewPaper(id: string, options?: Parameters<typeof fetchWorkerSourceJson>[2]) {
  const data = await fetchWorkerSourceJson<{ notes?: OpenReviewNote[] }>('/sources/openreview', { id }, options);
  const note = data?.notes?.[0];
  return note ? mapOpenReviewNote(note) : null;
}

/**
 * The paper a public key names (`parsePaperKey`): its DOI record, its
 * OpenAlex or PubMed work, its arXiv entry, or its OpenReview submission. Null
 * when the provider has no such paper; a provider failure rejects, so a page
 * can offer a retry.
 */
export async function loadPaperByIdentity(identity: NonNullable<ReturnType<typeof parsePaperKey>>) {
  // A paper only OpenReview holds: no other provider knows its id.
  if (identity.type === 'openreview') return fetchOpenReviewPaper(identity.value);

  // A DOI, and the papers the feed keys by provider id — an OpenAlex work, a
  // PubMed record — and remembers that way in Liked and Saved. OpenAlex
  // resolves all three as one work, abstract included, at no cost to the
  // day's budget; a failure here rejects so the page can offer a retry rather
  // than declare the paper missing.
  if (identity.type === 'doi' || identity.type === 'openalex' || identity.type === 'pmid') {
    return fetchPaperByWorkId(identity.type, identity.value);
  }

  return loadArxivPaper(identity.value);
}

// Once OpenAlex has the paper, how long after the arXiv request began the page
// still waits for arXiv's record, whose categories are the paper's own. The
// Worker's /arxiv answers in about 0.5 s from its cache and 2.4 s on a miss
// (measured 2026-11-21), but a miss can also wait up to 4 s for its seat on
// arXiv's beat (worker/arxiv-api.ts); an answer later than this one is not
// waited for, and the page shows OpenAlex's paper. Without it the page waited
// out the route's 6 s deadline (ARXIV_ROUTE_TIMEOUT_MS): on 2026-11-21 a
// failed arXiv request held a new reader for 8.5 s.
const ARXIV_PAGE_WAIT_MS = 4_000;

type ArxivAnswer = { paper: Paper | null } | { error: unknown };
type OpenAlexAnswer = Awaited<ReturnType<typeof fetchPaperByArxivIdViaOpenAlex>>;

const delay = (ms: number) => new Promise<null>(resolve => { setTimeout(() => resolve(null), ms); });

/**
 * The paper an arXiv id names, for its public page: arXiv's record with
 * OpenAlex's enrichment merged before it is shown, or OpenAlex's paper when
 * arXiv fails or is slow. OpenAlex is asked once, beside arXiv rather than
 * after it, by the one request that is both the fallback and the enrichment:
 * every view of a paper asks OpenAlex the same thing, so the Worker's cache
 * answers it for the next reader. When this browser already holds the
 * enrichment, OpenAlex is asked only if arXiv fails, as before.
 *
 * arXiv's request keeps running after the page has moved on and lands in the
 * arXiv service's in-memory cache. The card is not upgraded under the reader:
 * its metadata is settled before display.
 */
export async function loadArxivPaper(arxivId: string, {
  fetchArxiv = fetchPapersByIds,
  pageWaitMs = ARXIV_PAGE_WAIT_MS,
} = {}): Promise<Paper | null> {
  const bareId = arxivId.replace(/v\d+$/i, '');
  const startedAt = Date.now();
  const arxiv: Promise<ArxivAnswer> = fetchArxiv([arxivId]).then(
    papers => ({ paper: papers[0] || null }),
    (error: unknown) => ({ error }),
  );
  if (hasCachedEnrichment(bareId)) return settleArxivPaper(await arxiv, bareId);

  const openAlex = fetchPaperByArxivIdViaOpenAlex(bareId);
  const first = await Promise.race([arxiv, openAlex.then(found => ({ found }))]);
  if (!('found' in first)) return settleArxivPaper(first, bareId, openAlex);
  if (!first.found) return settleArxivPaper(await arxiv, bareId, openAlex);

  const late = await Promise.race([arxiv, delay(Math.max(0, pageWaitMs - (Date.now() - startedAt)))]);
  return late ? settleArxivPaper(late, bareId, openAlex) : withArxivPdf(first.found.paper, bareId);
}

async function settleArxivPaper(answer: ArxivAnswer, bareId: string, openAlex?: Promise<OpenAlexAnswer>) {
  const paper = 'paper' in answer ? answer.paper : null;
  if ('error' in answer) console.warn('arXiv refused the paper, falling back to OpenAlex', answer.error);

  if (!paper) {
    // arXiv rate-limits by IP in bursts (a 429 ban that lasts minutes), and it
    // must not decide whether this page works: OpenAlex indexes the same
    // preprints, abstract included.
    const fallback = await (openAlex ?? fetchPaperByArxivIdViaOpenAlex(bareId));
    return fallback ? withArxivPdf(fallback.paper, bareId) : null;
  }

  const enrichmentId = getOpenAlexEnrichmentId(paper) || bareId;
  if (openAlex) {
    const found = await openAlex;
    return found?.enrichment ? mergeOpenAlexEnrichment([paper], { [enrichmentId]: found.enrichment })[0] : paper;
  }
  try {
    // This browser's cache answers, without a request.
    const enrichment = await enrichPapersBatch([enrichmentId], { timeoutMs: 6_500 });
    return mergeOpenAlexEnrichment([paper], enrichment)[0];
  } catch (error) {
    console.warn('Public paper OpenAlex enrichment failed', error);
    return paper;
  }
}

// The PDF link is derived from the arXiv id we were asked for, since OpenAlex
// only sometimes carries one.
function withArxivPdf(paper: Paper, bareId: string): Paper {
  return { ...paper, pdfUrl: paper.pdfUrl || `https://arxiv.org/pdf/${bareId}` };
}
