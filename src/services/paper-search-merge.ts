import type { Paper } from '../models/paper.ts';

import { rankPaperSearchResults, scorePaperSearchMatch } from '../utils/search-relevance.ts';
import { PaperBuilder } from './paper-builder.ts';

/**
 * The step both paper searches share, the browser's
 * (`searchPapersAcrossSources`) and the MCP server's: one list from OpenAlex
 * and the other sources, ranked by title match, then cut. Free of browser modules, so the
 * Worker can import it.
 *
 * OpenAlex first: `deduplicate` keeps the position of the first record of a
 * group, so a paper OpenAlex also found stays where OpenAlex ranked it and only
 * the papers it lacks are appended, before the title ranking runs. Cutting
 * before ranking would drop a title match OpenAlex lacks whenever OpenAlex
 * fills its page.
 *
 * `minimumTitleScore` drops papers whose title matches the query less well;
 * the default keeps everything, a paper found only through its abstract
 * included.
 */
export function mergeRankedPapers(
  query: string,
  openAlexPapers: Array<Partial<Paper> | null>,
  otherPapers: Array<Partial<Paper> | null>,
  { limit, minimumTitleScore = 0 }: { limit: number; minimumTitleScore?: number },
) {
  const merged = PaperBuilder.deduplicate([...openAlexPapers, ...otherPapers]);
  return rankPaperSearchResults(query, merged)
    .filter(paper => minimumTitleScore <= 0 || scorePaperSearchMatch(query, paper) >= minimumTitleScore)
    .slice(0, limit);
}
