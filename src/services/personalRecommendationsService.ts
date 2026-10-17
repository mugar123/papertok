import type { PositiveExample } from '../utils/interactionProfile.ts';
import { authenticatedWorkerFetch, sourceResponseError, workerSourceUrl } from './workerApiClient.ts';

export interface PersonalCandidate { arxivId: string | null; doi: string | null; }
export interface PersonalRecommendationRequest { positive: string[]; negative: string[]; }

// The Worker's caps per request (`worker/semantic-scholar.ts`).
const POSITIVES_PER_REQUEST = 10;
const NEGATIVE_EXAMPLES = 10;
// The Worker can sleep up to 2.5 s for the beat before its 6 s upstream
// deadline, the same budget `relatedPapersService` gives `/related`.
const REQUEST_TIMEOUT_MS = 11000;

// Inside the Worker's own limits on an id: one id it refuses refuses the request.
const isExampleDoi = (doi: string) => /^10\.\d{4,9}\/\S+$/.test(doi) && doi.length <= 253;

/**
 * The id Semantic Scholar knows a feed paper by, or null for the sources it
 * cannot be asked about by id (OpenAlex works, CORE, OSTI and the like). The
 * arXiv feed keeps bare arXiv ids, DataCite bare DOIs.
 */
export function semanticScholarExampleId(paperId: string): string | null {
  const id = String(paperId || '').trim();
  const arxivId = id.replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  if (/^\d{4}\.\d{4,5}$/.test(arxivId) || /^[a-z][a-z.-]+\/\d{7}$/i.test(arxivId)) return `ARXIV:${arxivId}`;
  const pmid = id.match(/^pmid:(\d{1,12})$/i);
  if (pmid) return `PMID:${pmid[1]}`;
  const doi = id.replace(/^(?:doi|crossref):/i, '');
  if (isExampleDoi(doi)) return `DOI:${doi}`;
  const biorxiv = id.match(/^biorxiv:(.+):v\d+$/i);
  if (biorxiv) {
    try {
      const biorxivDoi = decodeURIComponent(biorxiv[1]);
      return isExampleDoi(biorxivDoi) ? `DOI:${biorxivDoi}` : null;
    } catch {
      return null;
    }
  }
  return /^[a-f0-9]{40}$/i.test(id) ? id.toLowerCase() : null;
}

/**
 * One interest per profile load, so a load spends one second of the shared
 * Semantic Scholar beat. Asked all at once, the examples of a reader who likes
 * both astrophysics and machine learning describe something between the two
 * that is neither; asked per category, each interest gets papers of its own.
 * The interest is the category of one example drawn at random, so an interest
 * comes up as often as the reader gives examples of it, and over a few loads
 * every interest does. Its newest examples are sent with the newest rejections.
 */
export function personalRecommendationRequest(
  positives: PositiveExample[],
  negativeIds: string[],
  random: () => number = Math.random,
): PersonalRecommendationRequest | null {
  const usable = positives
    .map(example => ({ id: semanticScholarExampleId(example.id), category: example.category }))
    .filter((example): example is { id: string; category: string } => Boolean(example.id));
  if (usable.length === 0) return null;
  const interest = usable[Math.min(usable.length - 1, Math.floor(random() * usable.length))].category;
  return {
    positive: [...new Set(usable.filter(example => example.category === interest).map(example => example.id))]
      .slice(0, POSITIVES_PER_REQUEST),
    negative: [...new Set(negativeIds.map(semanticScholarExampleId).filter((id): id is string => Boolean(id)))]
      .slice(0, NEGATIVE_EXAMPLES),
  };
}

/**
 * The Worker's answer, or nothing when it cannot give one: a refusal, a
 * timeout or a Worker that does not have the route yet leaves the feed with
 * its other sources.
 */
export async function fetchPersonalCandidates(
  request: PersonalRecommendationRequest | null,
  { fetchWorker = authenticatedWorkerFetch, apiBase }: {
    fetchWorker?: (url: string, init: RequestInit) => Promise<Response>;
    apiBase?: string;
  } = {},
): Promise<PersonalCandidate[]> {
  const url = workerSourceUrl('/recommendations', {}, apiBase);
  if (!url || !request) return [];
  try {
    const response = await fetchWorker(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      console.warn('Personal recommendations unavailable', sourceResponseError('/recommendations', response.status, detail));
      return [];
    }
    const payload = await response.json() as { papers?: unknown };
    if (!Array.isArray(payload?.papers)) return [];
    return payload.papers
      .map(paper => ({
        arxivId: typeof paper?.arxivId === 'string' && paper.arxivId ? paper.arxivId : null,
        doi: typeof paper?.doi === 'string' && paper.doi ? paper.doi : null,
      }))
      .filter(candidate => candidate.arxivId || candidate.doi);
  } catch (error) {
    console.warn('Personal recommendations unavailable', error);
    return [];
  }
}
