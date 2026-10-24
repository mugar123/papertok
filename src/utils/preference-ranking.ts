import { getCategoryArea } from '../data/categories.ts';

const AFFINITY_DEAD_BAND = 2;

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
 * and no engineering at all until its interactions said otherwise.
 *
 * Ids outside the schema (a followed topic that maps to no area) keep their
 * relative order in a group of their own.
 *
 * An affinity smaller than AFFINITY_DEAD_BAND either way counts as none. One
 * skip, or one view under half the reader's median, weighs -1
 * (interaction-profile.ts), and a decayed affinity never reaches zero: one
 * quick skip of a cs.AI card used to move cs.AI from first to last of ten
 * interests, out of every query, for good.
 */
export function rankPreferences(preferences: string[], affinities: Record<string, number> = {}) {
  const ids = [...new Set((preferences || []).filter(id => typeof id === 'string' && id))];
  const score = (id: string) => {
    const value = Number(affinities?.[id]) || 0;
    return Math.abs(value) < AFFINITY_DEAD_BAND ? 0 : value;
  };
  const tiers = new Map<number, string[]>();
  for (const id of ids) {
    const value = score(id);
    if (!tiers.has(value)) tiers.set(value, []);
    tiers.get(value)!.push(id);
  }
  return [...tiers.keys()]
    .sort((a, b) => b - a)
    .flatMap(value => interleaveByArea(tiers.get(value)!));
}

function interleaveByArea(ids: string[]) {
  const byArea = new Map<string, string[]>();
  for (const id of ids) {
    const area = getCategoryArea(id) ?? '';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area)!.push(id);
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
