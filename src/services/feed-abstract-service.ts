import type { Paper } from '../models/paper.ts';
import { fetchPapersByIds } from './arxiv-service.ts';
import { fetchInspireAbstracts } from './inspire-abstract-service.ts';
import { getMissingArxivAbstractIds, getMissingAbstractDois } from '../utils/feed-enrichment.ts';
import { awaitWithinGate } from '../utils/feed-citation-gate.ts';

/** Abstract records for `mergeFeedAbstracts`, from arXiv by linked ID and INSPIRE by DOI. */
export async function recoverFeedAbstracts(papers: Paper[]): Promise<Partial<Paper>[]> {
  const ids = getMissingArxivAbstractIds(papers);
  const dois = getMissingAbstractDois(papers);
  // Feed pages fit in one arXiv batch. Bound queue time as well as the request;
  // an answer after this may warm the provider cache, never change a card.
  const records = await awaitWithinGate([
    ids.length ? fetchPapersByIds(ids.slice(0, 50)) : [],
    dois.length ? fetchInspireAbstracts(dois) : [],
  ], { maxWaitMs: 6_000 });
  return records.flatMap(batch => batch || []);
}
