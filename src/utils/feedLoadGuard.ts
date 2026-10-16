/**
 * Decides whether a feed load has genuinely failed. The old inline check threw
 * as soon as the four main sources produced zero papers and any of them had
 * failed — discarding graph, followed and other optional candidates that were
 * already fetched and could bootstrap the feed on their own.
 *
 * @param {Array<{status: string}>} sourceResults - settled results of the main sources
 * @param {Array<Array>} paperPools - every pool of candidate papers gathered so far
 * @returns {boolean} true when there is nothing to render AND at least one source failed
 */
export function shouldAbortFeedLoad(sourceResults = [], ...paperPools) {
  const totalPapers = paperPools.reduce((sum, pool) => sum + (pool?.length || 0), 0);
  if (totalPapers > 0) return false;
  return sourceResults.some(result => result?.status !== 'fulfilled');
}
