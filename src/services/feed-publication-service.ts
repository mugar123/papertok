import type { Paper } from '../models/paper.ts';
import { keepNotablePlaces } from '../utils/feed-enrichment.ts';
import { normalizeDoi } from '../utils/public-navigation.ts';
import { isFeedPublication, withCrossrefType } from './feed-publication-rules.ts';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABSENT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHED = 500;
// The lookup runs after the page is shown, so it can wait for answers that took
// 0.9-3.5 s in the PAP-51 measurements instead of dropping them at 2 s.
const LOOKUP_DEADLINE_MS = 6_000;
// A missed deadline describes Crossref or the network right now, not a DOI: the
// next page's lookup would most likely miss too, so it is not sent for a while.
const TIMEOUT_PAUSE_MS = 5 * 60 * 1000;
const STORAGE_KEY = 'papertok_publication_types_v1';
const cache = new Map<string, { type: string | null; expiresAt: number }>();
let restored = false;
let unsaved = false;
let requests: Promise<void> = Promise.resolve();
let retryAt = 0;
let nextRequestAt = 0;

/**
 * Removes confirmed books and book reviews the reader has not reached. The
 * visible card and the one after it stay, since a swipe shows the next card
 * before the scroll reports it as visible. With no card reported, the reader
 * is on the first card: a restore reports the card FeedContainer opens on, on
 * any page (FeedContext), and a refresh starts at the top. A reported card
 * that is no longer listed leaves their place unknown: nothing is removed.
 * The notable cards keep their places and the next card takes a removed
 * one's (keepNotablePlaces), so the reader still meets one in NOTABLE_EVERY.
 */
export function dropUnreachedPublications<T extends Partial<Paper>>(papers: T[], classified: Partial<Paper>[], visiblePaperId: string | null) {
  const visible = papers.findIndex(paper => paper.id === visiblePaperId);
  if (visiblePaperId && visible < 0) return papers;
  const excluded = new Set(classified.filter(paper => !isFeedPublication(paper)).map(paper => paper.id));
  const lastReached = Math.max(0, visible) + 1;
  const unreached = papers.slice(lastReached + 1);
  const kept = unreached.filter(paper => !excluded.has(paper.id));
  if (kept.length === unreached.length) return papers;
  return [...papers.slice(0, lastReached + 1), ...keepNotablePlaces(unreached, kept.filter(paper => !paper._notable), kept.filter(paper => paper._notable))];
}

/**
 * Removes the cards a late OpenAlex or Europe PMC record has called retracted
 * (`PaperBuilder.merge` keeps a retraction whichever record states it), by
 * the rule a confirmed book leaves by: only cards the reader has not reached.
 */
export function dropUnreachedRetractions<T extends Partial<Paper>>(papers: T[], visiblePaperId: string | null) {
  return dropUnreachedPublications(papers, papers.filter(paper => paper.publicationStatus === 'retracted'), visiblePaperId);
}

// Results outlive the tab, so a reopened app does not ask Crossref again for
// the DOIs it has just shown. Stored values are checked like a response.
function restore() {
  if (restored) return;
  restored = true;
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const now = Date.now();
    for (const [doi, entry] of Object.entries(stored)) {
      if (cache.size >= MAX_CACHED) break;
      if (!Array.isArray(entry) || normalizeDoi(doi) !== doi) continue;
      const [type, expiresAt] = entry as unknown[];
      if ((type !== null && (typeof type !== 'string' || !/^[a-z-]+$/.test(type)))
        || typeof expiresAt !== 'number' || expiresAt <= now || expiresAt > now + CACHE_TTL_MS) continue;
      cache.set(doi, { type, expiresAt });
    }
  } catch {
    // Unreadable storage leaves the lookup to run again.
  }
}

function persist() {
  if (!unsaved) return;
  unsaved = false;
  try {
    const now = Date.now();
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...cache]
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([doi, entry]) => [doi, [entry.type, entry.expiresAt]]))));
  } catch {
    // Quota or privacy mode: this tab's results still apply.
  }
}

function remember(doi: string, type: string | null) {
  unsaved = true;
  cache.delete(doi);
  cache.set(doi, { type, expiresAt: Date.now() + (type ? CACHE_TTL_MS : ABSENT_TTL_MS) });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
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

/**
 * Look up candidates' types on Crossref, then apply what is known. The feeds
 * call this for each page they choose, without waiting for it; unavailable
 * evidence leaves types unchanged.
 */
export async function classifyFeedPublications(papers: Paper[]): Promise<Paper[]> {
  restore();
  const candidates = [...new Set(papers
    .filter(paper => paper.sources?.primary === 'openalex' && isFeedPublication(paper))
    .map(paper => normalizeDoi(paper.doi))
    // Commas are Crossref's filter delimiter; do not reinterpret a DOI as filters.
    .filter(doi => doi && !doi.includes(',') && doi.length <= 240))];
  if (candidates.some(doi => !cache.has(doi) || cache.get(doi)!.expiresAt <= Date.now())) {
    const controller = new AbortController();
    const lookup = requests.then(async () => {
      // The deadline starts here, not at the call: time spent behind an earlier
      // page's lookup says nothing about Crossref, and must not set the pause.
      const timer = setTimeout(() => controller.abort(), LOOKUP_DEADLINE_MS);
      // Recheck the per-DOI cache after earlier loads finish. One serial lane keeps
      // overlapping loads within Crossref's query concurrency limit.
      const missing = candidates.filter(doi => !cache.has(doi) || cache.get(doi)!.expiresAt <= Date.now()).slice(0, 80);
      try {
        for (let i = 0; i < missing.length; i += 20) {
          if (controller.signal.aborted || Date.now() < retryAt) break;
          await crossrefTypes(missing.slice(i, i + 20), controller.signal);
        }
      } finally {
        clearTimeout(timer);
        persist();
      }
    });
    requests = lookup.catch(() => {});
    try {
      await lookup;
    } catch (error) {
      if (controller.signal.aborted) retryAt = Math.max(retryAt, Date.now() + TIMEOUT_PAUSE_MS);
      else console.warn('Feed publication classification unavailable', error);
    }
  }
  return applyKnownPublicationTypes(papers);
}

/** Mark candidates this browser already knows to be books or book reviews, without a request. */
export function applyKnownPublicationTypes(papers: Paper[]): Paper[] {
  restore();
  return papers.map(paper => {
    const cached = cache.get(normalizeDoi(paper.doi));
    return withCrossrefType(paper, cached && cached.expiresAt > Date.now() ? cached.type : null);
  });
}
