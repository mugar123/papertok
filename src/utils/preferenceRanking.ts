import { getCategoryArea } from '../data/categories.ts';

const AFFINITY_DEAD_BAND = 2;

/**
 * The order the feed asks its sources in. Each source takes a few interests
 * at a time (five for arXiv and OpenAlex, three for PubMed) and pages take
 * turns over this list (preferencesForPage), so the order decides what the
 * first page is about.
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
 *
 * An affinity smaller than AFFINITY_DEAD_BAND either way counts as none. One
 * skip, or one view under half the reader's median, weighs -1
 * (interactionProfile.ts), and a decayed affinity never reaches zero: one
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

/**
 * The interests one page asks a source for, and which page of their own
 * results that is (0-based). A source takes `size` interests; with more than
 * that, the ranked list is cut in order into the fewest turns of at most
 * `size`, as even as possible, and pages take them in rotation. Ten interests
 * and five a query: page 0 asks for the first five, page 1 for the other five,
 * page 2 for the first five's second page. Every page used to ask for the
 * top `size`, so the interests below them were never asked for at all.
 */
export function preferencesForPage(ranked: readonly string[], page: number, size: number) {
  const turns = Math.max(1, Math.ceil(ranked.length / size));
  const turn = page % turns;
  return {
    ids: ranked.slice(Math.ceil(turn * ranked.length / turns), Math.ceil((turn + 1) * ranked.length / turns)),
    sourcePage: Math.floor(page / turns),
  };
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
