import type { Paper } from '../models/paper.ts';
import { parseArxivHtml, parseJats, type FullText } from '../utils/full-text.ts';
import { normalizeArxivFigureId } from './paper-figure-service.ts';
import { trustedWorkerUrl } from './worker-api-client.ts';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
// The reader waits this long before showing the PDF instead; the Worker gives
// the providers less (worker/full-text.ts), so its answer arrives in time.
const REQUEST_TIMEOUT_MS = 10_000;
// The last answers, so the press that opens the viewer and the viewer itself
// fetch and parse a document once.
const RECENT_LIMIT = 8;
const recent = new Map<string, FullText | null>();

type FullTextAnswer = {
  source: FullText['source'] | null;
  format: 'latexml' | 'jats' | null;
  url: string | null;
  fullTextId?: string;
  license?: string;
  document: string | null;
  unavailable?: true;
};

/** The identifiers the Worker can look a paper's text up by, or `null` if it has none. */
export function fullTextQuery(paper: Partial<Paper> | null | undefined) {
  const query = new URLSearchParams();
  const arxivId = normalizeArxivFigureId(paper);
  const pmcid = String(paper?.pmcid || '').trim();
  const doi = String(paper?.doi || '').trim();
  if (arxivId) query.set('arxiv_id', arxivId);
  if (pmcid) query.set('pmcid', pmcid);
  if (doi) query.set('doi', doi);
  return query.size ? query : null;
}

/**
 * The paper's full text, or `null` when no provider publishes it as text or it
 * cannot be fetched right now. Either way the reader shows the PDF instead.
 */
export async function getFullText(paper: Partial<Paper>, signal?: AbortSignal): Promise<FullText | null> {
  const query = fullTextQuery(paper);
  const url = query && PAPER_API_BASE ? trustedWorkerUrl(`${PAPER_API_BASE}/resources/full-text?${query}`) : '';
  if (!url) return null;
  const known = recent.get(url);
  if (known !== undefined) return known;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return null;
    const answer = await response.json() as FullTextAnswer;
    const doc = !answer.document || !answer.url ? null : answer.format === 'latexml'
      ? parseArxivHtml(answer.document, answer.url)
      : answer.format === 'jats' && answer.fullTextId
        ? parseJats(answer.document, answer.url, answer.fullTextId)
        : null;
    const usable = doc?.body.length ? doc : null;
    if (usable && answer.source) usable.source = answer.source;
    if (usable && !usable.license && answer.license) usable.license = answer.license;
    // A provider outage is asked about again next time.
    if (!answer.unavailable) {
      recent.delete(url);
      recent.set(url, usable);
      const oldest = recent.keys().next().value;
      if (recent.size > RECENT_LIMIT && oldest) recent.delete(oldest);
    }
    return usable;
  } catch {
    return null;
  }
}
