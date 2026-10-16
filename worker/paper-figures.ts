/**
 * Figure extraction for arXiv papers.
 *
 * arXiv publishes no figure API, so figures are read out of the rendered HTML
 * of the paper. Two renderers are needed, because neither covers the corpus:
 *
 *  - arxiv.org/html is arXiv's own conversion, and only exists for reasonably
 *    recent LaTeX submissions;
 *  - ar5iv is the community conversion of the back catalogue, and lags by
 *    roughly a year at the front.
 *
 * A feed of brand-new papers is served almost entirely by the first, and a
 * search through older work almost entirely by the second, so both are asked at
 * once and arXiv's answer is preferred when both have one.
 *
 * The client loads the images themselves directly with an <img>, which needs no
 * CORS grant and keeps image bytes off the worker entirely.
 *
 * Plenty of papers convert to neither. An empty list is an ordinary result.
 */

const RENDERERS = [
  { id: 'arxiv', origin: 'https://arxiv.org', url: (id) => `https://arxiv.org/html/${id}` },
  { id: 'ar5iv', origin: 'https://ar5iv.labs.arxiv.org', url: (id) => `https://ar5iv.labs.arxiv.org/html/${id}` },
];

const MAX_FIGURES = 6;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
/** A rendered paper does not change, so this is deliberately long. */
export const FIGURE_CACHE_SECONDS = 30 * 24 * 60 * 60;
/** An empty result may just mean the renderer has not published this paper
 *  yet, or that the fetch was slow, so it is only remembered briefly. */
export const FIGURE_EMPTY_CACHE_SECONDS = 60 * 60;

/** Identifiers issued since April 2007: `2608.20340`, `1706.03762`. */
const MODERN_ID = /^\d{4}\.\d{4,5}$/;
/**
 * Identifiers issued before then: `math/0309136`, `cond-mat.stat-mech/0102536`.
 *
 * That back catalogue is the whole reason the second renderer is here, so
 * rejecting it made ar5iv unreachable: the route answered 400 for every paper
 * only ar5iv can render. The pattern stays tight because the identifier is
 * interpolated into a renderer URL — one slash, exactly seven digits, and an
 * archive name that cannot hold a second dot, a further path segment, or
 * anything outside the letter/hyphen set.
 */
const LEGACY_ID = /^[a-z]+(?:-[a-z]+)?(?:\.[A-Za-z]+(?:-[A-Za-z]+)?)?\/\d{7}$/;

export function isArxivFigureId(value) {
  const id = String(value || '').trim();
  return MODERN_ID.test(id) || LEGACY_ID.test(id);
}

/**
 * `String.fromCharCode` truncates anything above the BMP, so an emoji entity
 * came out as a single wrong glyph. `fromCodePoint` handles those but throws on
 * a value out of range or on a lone surrogate half, so both are screened here
 * and a malformed entity is left as literal text rather than taken as an error.
 */
function codePointToText(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/**
 * Turns the entities a renderer emits in captions back into text.
 *
 * `&amp;` is decoded last on purpose. Decoding it first turned `&amp;lt;` into
 * `&lt;`, which the next pass then turned into a real `<`: markup the author
 * had escaped deliberately came back as markup. Since `replace` does not rescan
 * what it just wrote, leaving `&amp;` for the end decodes each entity exactly
 * once.
 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (match, digits) => codePointToText(Number(digits)) ?? match)
    // LaTeXML writes dashes and quotes as hex entities, which went untouched.
    .replace(/&#x([0-9a-fA-F]+);/g, (match, digits) => codePointToText(Number.parseInt(digits, 16)) ?? match)
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves a figure src against the page it came from.
 *
 * `baseUrl` is the response's final URL rather than the requested one: arXiv
 * redirects to a versioned path, and assets are relative to that version.
 * Only same-origin image files are accepted, so a rewritten page cannot point
 * the feed at an arbitrary host.
 */
function resolveAssetUrl(src, baseUrl, origin) {
  const raw = decodeEntities(src).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, baseUrl);
    if (url.origin !== origin) return '';
    // arXiv's page furniture — funder logos, mascots — lives under /static.
    if (url.pathname.startsWith('/static/')) return '';
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Pulls figures out of a rendered paper.
 *
 * Matches `<figure>` blocks rather than bare `<img>`, because both renderers
 * emit inline images for maths symbols; matching images alone fills the list
 * with single glyphs.
 *
 * A figure is not always an `<img>`: vector figures come through as
 * `<object type="image/svg+xml" data="...">`, and those are the diagrams worth
 * showing most. Both forms load fine from an <img> on the client.
 */
export function extractFiguresFromHtml(html, baseUrl, origin) {
  const figures = [];
  const seen = new Set();

  for (const match of String(html || '').matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi)) {
    const block = match[1];
    // An equation is marked up as a figure by both renderers; it is not one.
    if (/ltx_equation|ltx_eqn/i.test(match[0])) continue;

    const imgMatch = block.match(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/i);
    const objectMatch = block.match(/<object\b[^>]*\bdata="([^"]+)"[^>]*>/i);
    const asset = imgMatch || objectMatch;
    if (!asset) continue;
    const url = resolveAssetUrl(asset[1], baseUrl, origin);
    if (!url || seen.has(url)) continue;

    const captionMatch = block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    const altMatch = asset[0].match(/\balt="([^"]*)"/i);
    seen.add(url);
    figures.push({
      url,
      caption: (captionMatch ? stripTags(captionMatch[1]) : stripTags(altMatch?.[1] || '')).slice(0, 300),
    });
    if (figures.length >= MAX_FIGURES) break;
  }

  return figures;
}

/**
 * Builds a renderer URL for an identifier.
 *
 * A legacy identifier carries a real path separator (`math/0309136`), so the id
 * cannot go through `encodeURIComponent` whole: that turns the slash into `%2F`
 * and the renderer answers 404. Each segment is escaped on its own, which keeps
 * the separator meaningful and still escapes anything unexpected.
 */
function rendererUrl(renderer, arxivId) {
  return renderer.url(String(arxivId).split('/').map(encodeURIComponent).join('/'));
}

/**
 * Reads a response body and gives up the moment it passes `limit` bytes.
 *
 * The ceiling used to be a `content-length` check followed by `text()`. A
 * chunked response carries no `content-length`, so the check compared against
 * zero and let the response through, and `text()` then buffered the entire
 * document before a single byte was measured — the guard only ran once it could
 * no longer help. ar5iv is a community service rather than arXiv
 * infrastructure, so an unbounded document is not hypothetical, and the worker
 * has 128 MB to lose. Reading through the stream holds at most `limit` bytes.
 *
 * An oversized page yields null rather than the prefix already read: a
 * truncated document cuts figures in half, and that damage would be cached for
 * a month.
 */
export async function readHtmlWithinLimit(response, limit = MAX_HTML_BYTES) {
  // Still worth checking: a declared size spares us reading the body at all.
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  const reader = response.body?.getReader?.();
  // A response with no stream at all — 204, HEAD, or a stubbed double.
  if (!reader) {
    const text = await response.text();
    return text.length > limit ? null : text;
  }

  const decoder = new TextDecoder('utf-8');
  let html = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) return null;
      // `stream: true` so a character split across two chunks is not decoded
      // as a pair of replacement characters.
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    // Whether the ceiling tripped or the deadline fired, the connection is
    // released instead of left draining a document nobody will read.
    reader.cancel().catch(() => {});
  }
}

async function fetchFromRenderer(renderer, arxivId) {
  const url = rendererUrl(renderer, arxivId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/html',
        'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      },
    });
    if (!response.ok) return [];

    // Awaited inside the try on purpose: `fetch` settles on the headers, so a
    // body read that escaped this block would run with the deadline disarmed.
    const html = await readHtmlWithinLimit(response, MAX_HTML_BYTES);
    if (html === null) return [];
    return extractFiguresFromHtml(html, response.url || url, renderer.origin);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Asks every renderer at once and answers with the first one that is both
 * preferred and non-empty.
 *
 * Asking them one after the other cost two full deadlines — up to 30 s — for a
 * paper neither has rendered, which is an ordinary result, and that empty
 * answer is only cached for an hour, so the bill came round again every hour
 * per paper. Racing them outright would throw away the other half of the
 * design: arXiv's own conversion is preferred over ar5iv's, and ar5iv is
 * usually the quicker of the two, so `Promise.any` would quietly demote arXiv.
 *
 * So the requests are started together and then awaited in preference order.
 * The network work overlaps, which puts the worst case at one deadline instead
 * of two, while the decision still reads arXiv's answer first. The only wait
 * left is the one preference actually requires: ar5iv's figures cannot be
 * accepted until it is known that arXiv has none.
 */
export async function fetchPaperFigures(arxivId) {
  if (!isArxivFigureId(arxivId)) return { id: arxivId, figures: [], source: null };

  // Started before the first await, so all of them are in flight together.
  // `fetchFromRenderer` resolves to [] on any failure, so an attempt whose
  // result is never read cannot surface as an unhandled rejection.
  const attempts = RENDERERS.map((renderer) => fetchFromRenderer(renderer, arxivId));

  for (const [index, renderer] of RENDERERS.entries()) {
    const figures = await attempts[index];
    if (figures.length > 0) return { id: arxivId, figures, source: renderer.id };
  }
  return { id: arxivId, figures: [], source: null };
}
