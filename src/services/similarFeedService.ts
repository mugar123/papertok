import type { Paper } from '../models/Paper.ts';

import { fetchPapersByIds } from './arxivService.ts';
import { enrichPapersBatch, fetchPapersByDois } from './openAlexService.ts';
import { RELATED_UPSTREAM_LIMIT, getRelatedPapers } from './relatedPapersService.ts';
import { areaLabelForPaper } from '../utils/areaAccent.ts';
import { awaitWithinGate } from '../utils/feedCitationGate.ts';
import { mergeOpenAlexEnrichment } from '../utils/feedEnrichment.ts';
import { getPublicPaperPath, normalizeArxivId, normalizeDoi } from '../utils/publicNavigation.ts';

// How long the Similar feed waits for arXiv and OpenAlex before it shows the
// papers they have classified by then. The related card from the citation
// map waits the same eight seconds for its own hydration.
const CLASSIFY_WAIT_MS = 8_000;

const arxivKey = (paper: Partial<Paper>) => normalizeArxivId(paper.arxivId).replace(/v\d+$/, '');

interface ClassifyDependencies {
  fetchArxiv?: (ids: string[]) => Promise<Paper[]>;
  enrich?: typeof enrichPapersBatch;
  fetchByDois?: (dois: string[]) => Promise<Paper[]>;
}

/**
 * Semantic Scholar's recommendations say which papers, and in what order —
 * not what they are: they carry no categories, topics or field (a card built
 * from one alone read "Research Paper", PAP-50), and the record calls every
 * one of them published. So each is shown as its own page would load it
 * (`loadPaperByIdentity`): the arXiv record with OpenAlex's topics on top for
 * an arXiv paper, the OpenAlex work for a DOI — and the DOI's work stands in
 * when arXiv does not answer. Only papers the card can name a field for are
 * kept; `unclassified` counts the rest so the feed can say they were left out.
 */
export async function classifySimilarPapers(related: Paper[], {
  fetchArxiv = fetchPapersByIds,
  enrich = enrichPapersBatch,
  fetchByDois = fetchPapersByDois,
}: ClassifyDependencies = {}) {
  const arxivIds = [...new Set(related.map(arxivKey).filter(Boolean))];
  const dois = [...new Set(related.map(paper => normalizeDoi(paper.doi)).filter(Boolean))];
  const [arxivRecords, enrichment, doiRecords] = await awaitWithinGate([
    arxivIds.length ? fetchArxiv(arxivIds) : [],
    arxivIds.length ? enrich(arxivIds, { timeoutMs: CLASSIFY_WAIT_MS }) : {},
    dois.length ? fetchByDois(dois) : [],
  ], { maxWaitMs: CLASSIFY_WAIT_MS });
  const byArxiv = new Map((arxivRecords || []).map(record => [arxivKey(record), record]));
  const byDoi = new Map((doiRecords || []).map(record => [normalizeDoi(record.doi), record]));
  const resolved = related.map((paper) => {
    const arxivRecord = byArxiv.get(arxivKey(paper));
    if (arxivRecord) return mergeOpenAlexEnrichment([arxivRecord], enrichment || {})[0];
    return byDoi.get(normalizeDoi(paper.doi)) || null;
  });
  const papers = resolved.filter((paper): paper is Paper => Boolean(paper && areaLabelForPaper(paper)));
  return { papers, unclassified: related.length - papers.length };
}

/** The Similar feed for `anchor`: its recommendations, classified. */
export async function loadSimilarPapers(anchor: Paper, onClassifying?: () => void) {
  // A paper Semantic Scholar knows only by its own hash has no page here and
  // nothing arXiv or OpenAlex could find it by.
  const related = (await getRelatedPapers(anchor, RELATED_UPSTREAM_LIMIT)).filter(paper => getPublicPaperPath(paper));
  onClassifying?.();
  return classifySimilarPapers(related);
}
