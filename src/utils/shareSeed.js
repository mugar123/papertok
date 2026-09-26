import { plainScientificText } from './plainScientificText.js';

/**
 * The paper a shared link's document was sent with.
 *
 * A crawler opening /public/paper/<key> gets the page from the Worker
 * (worker/share-pages.js), with the paper written into the document as JSON.
 * Googlebot renders JavaScript but may not reach the API the page loads from
 * (api.papertok.app's robots.txt is `Disallow: /`), so without this its
 * render ended on the loading or error state — both noindex — for a paper the
 * document already held (audit 2026-09-23, issue 5).
 *
 * The seed names the key it was written for, and is read only for that key:
 * a stale document can never dress one paper up as another.
 */
export const SHARE_SEED_ELEMENT_ID = 'papertok-share-seed';

export function parseShareSeed(text, paperKey) {
  if (!text || !paperKey) return null;
  let seed;
  try {
    seed = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!seed || typeof seed !== 'object' || Array.isArray(seed) || seed.key !== paperKey) return null;
  const paper = seed.paper;
  if (!paper || typeof paper !== 'object' || Array.isArray(paper)) return null;
  return String(paper.title || '').trim() ? paper : null;
}

export function readShareSeed(paperKey, doc = globalThis.document) {
  const element = doc?.getElementById?.(SHARE_SEED_ELEMENT_ID);
  return element ? parseShareSeed(element.textContent, paperKey) : null;
}

/**
 * The paper page's head. Only a page with no paper yet is noindex: one
 * painted from a seed is the paper, and says so from its first render. Title
 * and summary as plain text, as the Worker writes them, since a tab title and
 * a search snippet render no LaTeX.
 */
export function publicPaperMetadata(paper, route) {
  if (!paper) return { route, noIndex: true };
  const title = plainScientificText(paper.title) || String(paper.title || '');
  const description = plainScientificText(paper.abstract) || String(paper.abstract || '');
  return {
    title: { en: title },
    description: { en: description },
    route,
    ogType: 'article',
  };
}
