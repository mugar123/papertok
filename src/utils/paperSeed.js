import { hasUsableAIAbstract } from './aiExplanationAccess.js';

/**
 * Whether the copy of a paper a link handed over is worth painting as the
 * page, or only worth keeping as the fallback.
 *
 * The screens that hand the paper page a stored copy — a list, a profile tab —
 * carry a title, authors and sometimes a truncated summary, and often no
 * abstract at all. Painting such a copy on arrival showed "Abstract
 * unavailable." for a beat and then, when arXiv and OpenAlex answered, the
 * real text popped in under it. A copy with no abstract is not the paper yet:
 * the page shows its skeleton until the providers answer, exactly as it does
 * for a link with no copy at all, and still falls back to the copy if they
 * never do. A copy that carries its abstract paints at once, as before.
 */
export function seedPaintsWhole(paper) {
  if (!paper || typeof paper !== 'object') return false;
  if (!String(paper.title || '').trim()) return false;
  return hasUsableAIAbstract(paper.abstract);
}
