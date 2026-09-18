import { getCategoryArea } from '../data/categories.js';

/**
 * The order the feed asks its sources in — and, since each source only takes
 * the first few (five for arXiv and OpenAlex, three for PubMed), the order
 * that decides what a page is about.
 *
 * Affinity first, highest on top. Among equals — and on a new account every
 * preference is an equal, at zero — the tie is broken by interleaving areas:
 * the first preference of each area in the order the areas first appear,
 * then the second of each, and so on. A plain stable sort kept the list's
 * own order, which is the taxonomy's, so an account seeded with physics,
 * electrical and mechanical engineering asked for five physics categories
 * and no engineering at all until its interactions said otherwise
 * (docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md, hallazgo 3).
 *
 * Ids outside the schema (a followed topic that maps to no area) keep their
 * relative order in a group of their own.
 */
export function rankPreferences(preferences, affinities = {}) {
  const ids = [...new Set((preferences || []).filter(id => typeof id === 'string' && id))];
  const score = (id) => Number(affinities?.[id]) || 0;
  const tiers = new Map();
  for (const id of ids) {
    const value = score(id);
    if (!tiers.has(value)) tiers.set(value, []);
    tiers.get(value).push(id);
  }
  return [...tiers.keys()]
    .sort((a, b) => b - a)
    .flatMap(value => interleaveByArea(tiers.get(value)));
}

function interleaveByArea(ids) {
  const byArea = new Map();
  for (const id of ids) {
    const area = getCategoryArea(id) ?? '';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(id);
  }
  const lists = [...byArea.values()];
  const out = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index < list.length) {
        out.push(list[index]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
