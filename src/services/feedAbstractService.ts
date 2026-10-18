import type { Paper } from '../models/Paper.ts';
import { fetchPapersByIds } from './arxivService.ts';
import { fetchInspireAbstracts } from './inspireAbstractService.ts';
import { getMissingArxivAbstractIds, getMissingAbstractDois, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';
import { awaitWithinGate } from '../utils/feedCitationGate.ts';

export async function recoverFeedAbstracts(papers: Paper[]) {
  const ids = getMissingArxivAbstractIds(papers);
  const dois = getMissingAbstractDois(papers);
  // Feed pages fit in one arXiv batch. Bound queue time as well as the request;
  // an answer after admission may warm the provider cache, never change a card.
  const records = await awaitWithinGate([
    ids.length ? fetchPapersByIds(ids.slice(0, 50)) : [],
    dois.length ? fetchInspireAbstracts(dois) : [],
  ], { maxWaitMs: 6_000 });
  return mergeFeedAbstracts(papers, records.flatMap(batch => batch || []));
}
