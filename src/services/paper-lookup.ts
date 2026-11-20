import type { parsePaperKey } from '../utils/public-navigation.ts';
import type { OpenReviewNote } from './open-review-service.ts';

import { fetchPapersByIds } from './arxiv-service.ts';
import {
  enrichPapersBatch,
  fetchPaperByArxivIdViaOpenAlex,
  fetchPaperByWorkId,
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

  let paper = null;
  try {
    const papers = await fetchPapersByIds([identity.value]);
    paper = papers[0] || null;
  } catch (error) {
    console.warn('arXiv refused the paper, falling back to OpenAlex', error);
  }

  if (!paper) {
    // arXiv rate-limits by IP in bursts (a 429 ban that lasts minutes), and it
    // must not decide whether this page works: OpenAlex indexes the same
    // preprints, abstract included. The PDF link is derived from the arXiv id
    // we were asked for, since OpenAlex only sometimes carries one.
    const fallback = await fetchPaperByArxivIdViaOpenAlex(identity.value);
    if (!fallback) return null;
    return {
      ...fallback,
      pdfUrl: fallback.pdfUrl || `https://arxiv.org/pdf/${identity.value.replace(/v\d+$/i, '')}`,
    };
  }

  try {
    const enrichmentId = getOpenAlexEnrichmentId(paper) || identity.value.replace(/v\d+$/i, '');
    const enrichment = await enrichPapersBatch([enrichmentId], { timeoutMs: 6_500 });
    return mergeOpenAlexEnrichment([paper], enrichment)[0];
  } catch (error) {
    console.warn('Public paper OpenAlex enrichment failed', error);
    return paper;
  }
}
