/**
 * The source document of an open paper's full text, for the in-app reader.
 *
 * The reader shows a paper in PaperTok's own type when a provider publishes it
 * as structured text: arXiv's LaTeXML conversion (arxiv.org/html, then ar5iv
 * for the back catalogue) or Europe PMC's JATS XML. This route fetches that
 * document and hands it over unchanged; the browser parses it
 * (src/utils/full-text.ts). It goes through the Worker so the repositories
 * never see the reader's address, as the privacy page promises.
 *
 * A paper no provider publishes as text is an ordinary answer, `document:
 * null`, and the reader falls back to the PDF.
 */
import { isArxivFigureId, readHtmlWithinLimit } from './paper-figures.ts';

export const FULL_TEXT_CACHE_SECONDS = 30 * 24 * 60 * 60;
/** An empty answer may only mean the provider has not converted the paper yet,
 *  so it is kept for an hour. */
export const FULL_TEXT_EMPTY_CACHE_SECONDS = 60 * 60;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** One deadline for the whole lookup, every provider included: under the
 *  reader's 10 s wait (src/services/full-text-service.ts). */
const LOOKUP_DEADLINE_MS = 9_000;
const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

const FULL_TEXT_ID = /^(PMC|PPR)\d{1,12}$/;
const DOI = /^10\.\d{4,9}\/[^\s"]{1,300}$/;

export type FullTextRequest = { arxivId: string; fullTextId: string; doi: string };

export type FullTextAnswer = {
  source: 'arxiv' | 'ar5iv' | 'europepmc' | null;
  format: 'latexml' | 'jats' | null;
  url: string | null;
  fullTextId?: string;
  license?: string;
  document: string | null;
  /** A provider failed, so the absence of text is not established. */
  unavailable?: true;
};


const NONE: FullTextAnswer = { source: null, format: null, url: null, document: null };

/** The identifiers the route will send upstream, or `null` when none is usable. */
export function normalizeFullTextRequest(params: URLSearchParams): FullTextRequest | null {
  const arxivId = String(params.get('arxiv_id') || '').trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
  const fullTextId = String(params.get('pmcid') || '').trim().toUpperCase();
  const doi = String(params.get('doi') || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
  const request = {
    arxivId: isArxivFigureId(arxivId) ? arxivId : '',
    fullTextId: FULL_TEXT_ID.test(fullTextId) ? fullTextId : '',
    doi: DOI.test(doi) ? doi : '',
  };
  return request.arxivId || request.fullTextId || request.doi ? request : null;
}

async function fetchText(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { accept, 'user-agent': USER_AGENT } });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  // Read inside the caller's deadline: `fetch` settles on the headers alone.
  const text = await readHtmlWithinLimit(response, MAX_DOCUMENT_BYTES);
  return text === null ? null : { text, url: response.url || url };
}

async function fromArxiv(arxivId: string, signal: AbortSignal): Promise<FullTextAnswer | null> {
  const renderers = [
    { source: 'arxiv' as const, url: `https://arxiv.org/html/${arxivId}` },
    { source: 'ar5iv' as const, url: `https://ar5iv.labs.arxiv.org/html/${arxivId}` },
  ];
  let failure: unknown = null;
  for (const renderer of renderers) {
    // One renderer failing still leaves the other to ask.
    const page = await fetchText(renderer.url, 'text/html', signal).catch((error: unknown) => {
      failure = error;
      return null;
    });
    // arXiv answers 200 with a notice for a paper it has not converted.
    if (page?.text.includes('ltx_document')) {
      return { source: renderer.source, format: 'latexml', url: page.url, document: page.text };
    }
  }
  if (failure) throw failure;
  return null;
}

async function europePmcRecord(doi: string, signal: AbortSignal) {
  const url = new URL(`${EUROPE_PMC}/search`);
  url.searchParams.set('query', `DOI:"${doi}"`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('resultType', 'core');
  url.searchParams.set('pageSize', '1');
  const response = await fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} from Europe PMC search`);
  const hit = (await response.json<{ resultList?: { result?: Array<Record<string, unknown>> } }>())?.resultList?.result?.[0];
  if (!hit || hit.isOpenAccess !== 'Y') return null;
  const listed = (hit.fullTextIdList as { fullTextId?: unknown[] } | undefined)?.fullTextId?.[0];
  const fullTextId = String(listed || hit.pmcid || '').toUpperCase();
  return FULL_TEXT_ID.test(fullTextId)
    ? { fullTextId, license: typeof hit.license === 'string' ? hit.license : undefined }
    : null;
}

async function fromEuropePmc(request: FullTextRequest, signal: AbortSignal): Promise<FullTextAnswer | null> {
  const record = request.fullTextId
    ? { fullTextId: request.fullTextId, license: undefined }
    : await europePmcRecord(request.doi, signal);
  if (!record) return null;
  const page = await fetchText(`${EUROPE_PMC}/${record.fullTextId}/fullTextXML`, 'application/xml', signal);
  if (!page?.text.includes('<article')) return null;
  return {
    source: 'europepmc',
    format: 'jats',
    url: `https://europepmc.org/article/${record.fullTextId.startsWith('PPR') ? 'PPR' : 'PMC'}/${record.fullTextId}`,
    fullTextId: record.fullTextId,
    ...(record.license ? { license: record.license } : {}),
    document: page.text,
  };
}

/**
 * arXiv first, then Europe PMC. A provider that fails or runs past the deadline
 * leaves the reader on the PDF as well, but the answer says so (`unavailable`)
 * and is kept briefly rather than as a confirmed absence.
 */
export async function fetchFullText(request: FullTextRequest): Promise<FullTextAnswer> {
  const signal = AbortSignal.timeout(LOOKUP_DEADLINE_MS);
  let unavailable = false;
  const attempt = <T>(lookup: () => Promise<T | null>) => lookup().catch(() => {
    unavailable = true;
    return null;
  });
  if (request.arxivId) {
    const answer = await attempt(() => fromArxiv(request.arxivId, signal));
    if (answer) return answer;
  }
  if (request.fullTextId || request.doi) {
    const answer = await attempt(() => fromEuropePmc(request, signal));
    if (answer) return answer;
  }
  return unavailable ? { ...NONE, unavailable: true } : NONE;
}
