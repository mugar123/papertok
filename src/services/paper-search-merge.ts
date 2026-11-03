import type { Paper } from '../models/paper.ts';

import { rankPaperSearchResults, scorePaperSearchMatch } from '../utils/search-relevance.ts';
import { PaperBuilder } from './paper-builder.ts';

/**
 * The step both paper searches share, the browser's
 * (`searchPapersAcrossSources`) and the MCP server's: one list from the two
 * sources, ranked by title match, then cut. Free of browser modules, so the
 * Worker can import it.
 *
 * OpenAlex first: `deduplicate` keeps the position of the first record of a
 * group, so a paper both sources found stays where OpenAlex ranked it and only
 * the arXiv-only papers are appended, before the title ranking runs. Cutting
 * before ranking would drop an arXiv-only title match whenever OpenAlex fills
 * its page.
 *
 * `minimumTitleScore` drops papers whose title matches the query less well;
 * the default keeps everything, a paper found only through its abstract
 * included.
 */
export function mergeRankedPapers(
  query: string,
  openAlexPapers: Array<Partial<Paper> | null>,
  arxivPapers: Array<Partial<Paper> | null>,
  { limit, minimumTitleScore = 0 }: { limit: number; minimumTitleScore?: number },
) {
  const merged = PaperBuilder.deduplicate([...openAlexPapers, ...arxivPapers]);
  return rankPaperSearchResults(query, merged)
    .filter(paper => minimumTitleScore <= 0 || scorePaperSearchMatch(query, paper) >= minimumTitleScore)
    .slice(0, limit);
}
