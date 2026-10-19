import type { Paper } from '../models/Paper.ts';
import { normalizeDoi } from '../utils/publicNavigation.ts';

const BOOK_TYPES = new Set(['book', 'monograph', 'edited-book', 'reference-book', 'book-set', 'book-series']);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map<string, { type: string | null; expiresAt: number }>();
let requests: Promise<void> = Promise.resolve();
let retryAt = 0;
let nextRequestAt = 0;

// These publishers explicitly identify book reviews that Crossref calls journal-article.
// Checked 2026-10-18; corrections match identifiers, never titles or the word "review".
const BOOK_REVIEWS = new Map([
  ['10.2307/2309205', 'jstor'], // https://www.jstor.org/stable/i314912
  ['10.2307/2307774', 'jstor'], // https://www.jstor.org/stable/i314811
  ['10.1038/162006a0', 'nature'], // https://www.nature.com/articles/162006a0 (Books Received)
]);

function confirmedPublication(paper: Partial<Paper>) {
  const source = BOOK_REVIEWS.get(normalizeDoi(paper.doi));
  if (source) return { type: 'book-review', source };
  // Oda's book has no DOI in this OpenAlex record. Its author and ISBN link
  // identify https://link.springer.com/book/9783642725494, not a research review.
  if (paper.id === 'openalex:W1503277431'
    || (paper.sources?.primary === 'openalex' && paper.id === 'W1503277431')) {
    return { type: 'book', source: 'springer' };
  }
  return null;
}

export function isFeedPublication(paper: Partial<Paper>) {
  return !confirmedPublication(paper)
    && ![paper.publicationType, paper.sourceType].some(type => type === 'book-review' || BOOK_TYPES.has(type || ''));
}

function remember(doi: string, type: string | null) {
  cache.delete(doi);
  cache.set(doi, { type, expiresAt: Date.now() + (type ? CACHE_TTL_MS : 6 * 60 * 60 * 1000) });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
}

async function crossrefTypes(dois: string[], signal: AbortSignal) {
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) await new Promise<void>(resolve => {
    const timer = setTimeout(finish, delay);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
  signal.throwIfAborted();
  if (Date.now() < retryAt) return;
  nextRequestAt = Date.now() + 200;
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({
    filter: dois.map(doi => `doi:${doi}`).join(','),
    select: 'DOI,type',
    rows: String(dois.length),
    mailto: 'app@papertok.io',
  }).toString();
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 429 || response.status === 503) {
      const value = response.headers.get('retry-after');
      const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value || '') - Date.now();
      retryAt = Math.max(retryAt, Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60_000));
    }
    throw new Error(`Crossref publication lookup failed (${response.status})`);
  }
  const payload = await response.json() as { message?: { items?: Array<{ DOI?: unknown; type?: unknown }>; 'total-results'?: number } };
  const items = payload?.message?.items;
  if (!Array.isArray(items) || payload.message?.['total-results'] !== items.length || items.length > dois.length) {
    throw new Error('Invalid Crossref publication metadata');
  }
  const types = new Map<string, string>();
  for (const work of items) {
    const doi = normalizeDoi(work?.DOI);
    if (!dois.includes(doi) || typeof work?.type !== 'string' || !/^[a-z-]+$/.test(work.type) || types.has(doi)) {
      throw new Error('Invalid Crossref publication metadata');
    }
    types.set(doi, work.type);
  }
  for (const doi of dois) remember(doi, types.get(doi) || null);
}

/** Classify feed candidates before display; unavailable evidence leaves their type unchanged. */
export async function classifyFeedPublications(papers: Paper[]): Promise<Paper[]> {
  const candidates = [...new Set(papers
    .filter(paper => paper.sources?.primary === 'openalex' && isFeedPublication(paper))
    .map(paper => normalizeDoi(paper.doi))
    // Commas are Crossref's filter delimiter; do not reinterpret a DOI as filters.
    .filter(doi => doi && !doi.includes(',') && doi.length <= 240))];
  if (candidates.some(doi => !cache.has(doi) || cache.get(doi)!.expiresAt <= Date.now())) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const lookup = requests.then(async () => {
      // Recheck the per-DOI cache after earlier loads finish. One serial lane keeps
      // overlapping loads within Crossref's query concurrency limit.
      const missing = candidates.filter(doi => !cache.has(doi) || cache.get(doi)!.expiresAt <= Date.now()).slice(0, 80);
      for (let i = 0; i < missing.length; i += 20) {
        if (controller.signal.aborted || Date.now() < retryAt) break;
        await crossrefTypes(missing.slice(i, i + 20), controller.signal);
      }
    });
    requests = lookup.catch(() => {});
    try {
      await lookup;
    } catch (error) {
      if (!controller.signal.aborted) console.warn('Feed publication classification unavailable', error);
    } finally {
      clearTimeout(timer);
    }
  }

  return papers.map(paper => {
    const doi = normalizeDoi(paper.doi);
    const cached = cache.get(doi);
    const confirmed = confirmedPublication(paper);
    const type = confirmed?.type || (cached && cached.expiresAt > Date.now() ? cached.type : null);
    // journal-article describes a format, not a research purpose: it must not
    // replace an existing scientific review classification.
    if (!type || (!BOOK_TYPES.has(type) && type !== 'book-review')) return paper;
    const source = confirmed?.source || 'crossref';
    return {
      ...paper,
      publicationType: type,
      sources: { ...paper.sources, enrichedBy: [...new Set([...paper.sources.enrichedBy, source])] },
    };
  });
}
