/**
 * Semantic Scholar recommendations for the feed.
 *
 * This used to reach `api.semanticscholar.org` straight from the browser, with no
 * API key and a rate limiter built from a module variable. That limiter never
 * worked: `lastRequestTime` was read, awaited on, and only then written, so N
 * concurrent callers all read the same stale value, slept the same amount and
 * fired in the same tick. Even had it worked, a module variable counts per tab
 * while Semantic Scholar counts per provider — so the more tabs a reader had
 * open, the harder they rate-limited themselves.
 *
 * The recommendations now go through the Worker's `/related`, which holds the API
 * key, caches at the edge for a day, bounds the request, and reserves against one
 * global per-minute ceiling shared with `/sources/s2`. `getRelatedPapers` already
 * speaks to that route, so this module is the thin part: ask it, keep the arXiv
 * identifiers.
 */
import { getRelatedPapers } from './relatedPapersService.js';

const CACHE = new Map();
const RECOMMENDATION_LIMIT = 20;

/**
 * Get AI-based recommendations for a specific paper.
 *
 * `fetchRelated` is injectable for the same reason the adapters take a fetch:
 * `getRelatedPapers` needs a Firebase session and a configured Worker origin,
 * neither of which exists under `node --test`.
 *
 * @param {string} arxivId
 * @returns {Promise<string[]>} Array of recommended arXiv IDs
 */
export async function getPaperRecommendations(arxivId, { fetchRelated = getRelatedPapers } = {}) {
  if (!arxivId) return [];
  const cleanId = arxivId.replace(/v\d+$/, '');
  const cacheKey = `rec_${cleanId}`;

  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  try {
    const related = await fetchRelated({ arxivId: cleanId }, RECOMMENDATION_LIMIT);
    const arxivIds = related.map(paper => paper.arxivId).filter(Boolean);
    CACHE.set(cacheKey, arxivIds);
    return arxivIds;
  } catch (error) {
    // A failure is not an answer: leaving it uncached means the next feed advance
    // can still get recommendations once the route recovers.
    console.warn('Semantic Scholar recommendations unavailable', error);
    return [];
  }
}

// Same escape hatch `arxivService` exposes: a module-level cache that survives
// between tests makes the second one lie about what the first proved.
export function clearRecommendationCache() {
  CACHE.clear();
}
