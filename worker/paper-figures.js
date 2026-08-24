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
 * search through older work almost entirely by the second, so both are tried in
 * that order.
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

export function isArxivFigureId(value) {
  return /^\d{4}\.\d{4,5}$/.test(String(value || '').trim());
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
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

async function fetchFromRenderer(renderer, arxivId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(renderer.url(encodeURIComponent(arxivId)), {
      signal: controller.signal,
      headers: {
        accept: 'text/html',
        'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      },
    });
    if (!response.ok) return [];
    if (Number(response.headers.get('content-length') || 0) > MAX_HTML_BYTES) return [];

    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) return [];
    return extractFiguresFromHtml(html, response.url || renderer.url(arxivId), renderer.origin);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPaperFigures(arxivId) {
  if (!isArxivFigureId(arxivId)) return { id: arxivId, figures: [], source: null };

  for (const renderer of RENDERERS) {
    const figures = await fetchFromRenderer(renderer, arxivId);
    if (figures.length > 0) return { id: arxivId, figures, source: renderer.id };
  }
  return { id: arxivId, figures: [], source: null };
}
