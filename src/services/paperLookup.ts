import type { parsePaperKey } from '../utils/publicNavigation.ts';

import { fetchPapersByIds } from './arxivService.ts';
import {
  enrichPapersBatch,
  fetchPaperByArxivIdViaOpenAlex,
  fetchPaperByWorkId,
} from './openAlexService.ts';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
} from '../utils/feedEnrichment.ts';

/**
 * The paper a public key names (`parsePaperKey`): its DOI record, its
 * OpenAlex or PubMed work, or its arXiv entry. Null when the provider has no
 * such paper; a provider failure rejects, so a page can offer a retry.
 */
export async function loadPaperByIdentity(identity: NonNullable<ReturnType<typeof parsePaperKey>>) {
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
