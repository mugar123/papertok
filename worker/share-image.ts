import type { PaperShareCard, ShareCard } from './share-card.ts';
import type { ShareDependencies, ShareRoute } from './share-pages.ts';
import type { WorkerGlobals } from './env.ts';

import { DEFAULT_PUBLIC_ORIGIN, getShareImage } from '../src/utils/public-navigation.ts';
import { entityShareCard, matchShareRoute, paperShareCard, readRecord } from './share-pages.ts';

/**
 * GET or HEAD `/share/image/entity/:type/:id` or `/share/image/paper/:key`:
 * the PNG a shared profile's or paper's preview shows (worker/share-card.ts).
 * A crawler reads the page first, so the record is usually already kept in
 * this data centre; the card asks for it the same way, through `readRecord`,
 * and spends a lookup only when it is not.
 *
 * An entity or a paper the card cannot be drawn for (missing, failed to load,
 * a name or title the fonts cannot draw, a renderer error) answers its static
 * image by redirect, kept five minutes like the card itself, so a preview
 * always has a picture and a failure is not drawn again on every request. An
 * address with no looked-up entity behind it, a page found by a name alone
 * among them, has no card at all: 404.
 */

export interface ShareImageDependencies extends ShareDependencies {
  renderCard?: (card: ShareCard, photo: string | null) => Promise<Uint8Array>;
  renderPaperCard?: (card: PaperShareCard) => Promise<Uint8Array>;
  loadPhoto?: (url: string) => Promise<string | null>;
}

// Bumped whenever the card's look changes, so a kept card is drawn again.
const CARD_VERSION = 1;
const CARD_CACHE_ROOT = `https://papertok.internal/cache/share-card/v${CARD_VERSION}`;
const CARD_SECONDS = 24 * 60 * 60;
// A card drawn without the picture its entity has (Wikimedia was slow or
// down) is kept an hour, so recovery does not wait a day.
const DEGRADED_CARD_SECONDS = 60 * 60;
const FALLBACK_SECONDS = 5 * 60;

const PHOTO_MAX_BYTES = 1_000_000;
const PHOTO_TIMEOUT_MS = 4_000;
const PHOTO_MAX_REDIRECTS = 3;
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg']);
const WIKIMEDIA_USER_AGENT = 'PaperTok/1.0 (https://papertok.app; mailto:app@papertok.io)';

type EntityRoute = Extract<ShareRoute, { kind: 'entity' }>;
type PaperRoute = Extract<ShareRoute, { kind: 'paper' }>;

// Cards being drawn in this isolate: a fan-out of crawlers for one link draws once.
const drawsInFlight = new Map<string, Promise<Response>>();

/** The route a card address stands for, or null: only a paper or a looked-up entity has a card. */
export function matchShareImageRoute(url: URL): EntityRoute | PaperRoute | null {
  if (!url.pathname.startsWith('/share/image/')) return null;
  const inner = new URL(url);
  inner.pathname = `/share/${url.pathname.slice('/share/image/'.length)}`;
  const route = matchShareRoute(inner);
  if (!route || route.invalid) return null;
  if (route.kind === 'paper') return route;
  return route.kind === 'entity' && route.lookup ? route : null;
}

function isWikimedia(url: URL) {
  return url.protocol === 'https:' && (url.hostname === 'wikimedia.org' || url.hostname.endsWith('.wikimedia.org'));
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/**
 * The card's picture as a data URL, or null. Only Wikimedia is asked, every
 * redirect included; only a PNG or JPEG of at most 1 MB is kept, all within
 * one deadline.
 */
export function createPhotoLoader({ fetchImpl = fetch, timeoutMs = PHOTO_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
  return async function loadPhoto(url: string) {
    const signal = AbortSignal.timeout(timeoutMs);
    let next = new URL(url);
    try {
      for (let hop = 0; hop <= PHOTO_MAX_REDIRECTS; hop += 1) {
        if (!isWikimedia(next)) return null;
        const response = await fetchImpl(next, {
          redirect: 'manual',
          signal,
          headers: { accept: 'image/png, image/jpeg', 'user-agent': WIKIMEDIA_USER_AGENT },
        });
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
        const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (location) {
          await response.body?.cancel();
          next = new URL(location, next);
          continue;
        }
        if (!response.ok || !PHOTO_TYPES.has(type) || Number(response.headers.get('content-length')) > PHOTO_MAX_BYTES) {
          await response.body?.cancel();
          return null;
        }
        const bytes = await readAtMost(response, PHOTO_MAX_BYTES);
        return bytes && bytes.byteLength > 0 ? `data:${type};base64,${base64(bytes)}` : null;
      }
    } catch (error) {
      console.warn('Share card picture unavailable', (error as Error)?.message || error);
    }
    return null;
  };
}

// The body, or null as soon as it passes `limit` bytes: a missing or wrong
// content-length does not make the Worker read a large file to the end.
async function readAtMost(response: Response, limit: number) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// A response as the edge keeps it (`s-maxage`) and as a crawler gets it (`max-age`).
function answer(body: Uint8Array | null, status: number, headers: Record<string, string>, seconds: number) {
  return {
    kept: new Response(body, { status, headers: { ...headers, 'cache-control': `public, s-maxage=${seconds}` } }),
    sent: new Response(body, { status, headers: { ...headers, 'cache-control': `public, max-age=${seconds}` } }),
  };
}

function fallback(type: string) {
  return answer(null, 302, { location: `${DEFAULT_PUBLIC_ORIGIN}${getShareImage(type).path}` }, FALLBACK_SECONDS);
}

async function drawPaperCard(route: PaperRoute, deps: ShareImageDependencies) {
  const outcome = await readRecord(route, deps);
  const paper = outcome.found ? outcome.record?.paper : null;
  const card = paper ? paperShareCard(paper) : null;
  if (!card) return fallback('paper');
  try {
    const png = await deps.renderPaperCard!(card);
    return answer(png, 200, { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' }, CARD_SECONDS);
  } catch (error) {
    console.warn('Paper card could not be drawn', (error as Error)?.message || error);
    return fallback('paper');
  }
}

async function drawCard(route: EntityRoute | PaperRoute, deps: ShareImageDependencies) {
  if (route.kind === 'paper') return drawPaperCard(route, deps);
  const { renderCard, loadPhoto } = deps;
  const outcome = await readRecord(route, deps);
  const entity = outcome.found ? outcome.record?.entity : null;
  const card = entity ? entityShareCard(route, entity) : null;
  if (!card) return fallback(route.type);

  const photo = card.photoUrl ? await loadPhoto!(card.photoUrl) : null;
  let png;
  try {
    png = await renderCard!(card, photo);
  } catch (error) {
    console.warn('Share card could not be drawn', (error as Error)?.message || error);
    return fallback(route.type);
  }
  const seconds = card.photoUrl && !photo ? DEGRADED_CARD_SECONDS : CARD_SECONDS;
  return answer(png, 200, { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' }, seconds);
}

// What the edge kept, as a crawler gets it.
function fromCache(hit: Response) {
  const headers = new Headers(hit.headers);
  headers.set('cache-control', (hit.headers.get('cache-control') || '').replace('s-maxage', 'max-age'));
  return new Response(hit.body, { status: hit.status, headers });
}

export async function handleShareImage(request: Request, {
  cache = (globalThis as WorkerGlobals).caches?.default,
  ...deps
}: ShareImageDependencies = {}) {
  const route = matchShareImageRoute(new URL(request.url));
  if (!route) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': `public, max-age=${FALLBACK_SECONDS}` } });
  }
  const key = new Request(`${CARD_CACHE_ROOT}/${route.cacheId}`);
  let response = await cache?.match(key).then(hit => (hit ? fromCache(hit) : null), () => null) ?? null;
  if (!response) {
    let drawing = drawsInFlight.get(key.url);
    if (!drawing) {
      drawing = drawCard(route, { ...deps, cache }).then(async ({ kept, sent }) => {
        try {
          await cache?.put(key, kept);
        } catch {
          // A card that cannot be kept is still a card.
        }
        return sent;
      });
      drawsInFlight.set(key.url, drawing);
      void drawing.finally(() => drawsInFlight.delete(key.url)).catch(() => {});
    }
    response = (await drawing).clone();
  }
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
