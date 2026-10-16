import { CATEGORIES } from '../data/categories.js';

/**
 * How the guest page is dealt out among the areas a visitor picked.
 *
 * The page used to be whatever the first branch to reach four papers
 * returned, cut to twelve, with the later branches appended only if there was
 * room — and there never was. Which branch came first was decided by caches,
 * not by the choice: with Informática + Medicina the page was twelve AI papers
 * on the first visit (the domain branch, edge-cached, answers in ~3 ms) and
 * twelve PubMed papers on the reload (PubMed's own localStorage cache answers
 * with no request at all). Measured on production, 2026-09-23.
 *
 * Here every chosen area gets its share of the page, sources take turns
 * inside an area, and a card already on screen never moves.
 */

const AREA_BY_CATEGORY = new Map(Object.entries(CATEGORIES)
  .flatMap(([areaKey, area]) => Object.keys(area.subcategories || {}).map(categoryId => [categoryId, areaKey])));

/** The taxonomy area a paper belongs to, from its category ids; `null` if none is ours. */
export function areaOfPaper(paper) {
  if (!paper) return null;
  for (const value of [paper.primaryCategory, ...(paper.categories || [])]) {
    if (typeof value !== 'string') continue;
    if (CATEGORIES[value]) return value;
    const area = AREA_BY_CATEGORY.get(value);
    if (area) return area;
  }
  return null;
}

const keyOf = (paper) => String(paper?.doi || paper?.arxivId || paper?.id || '').toLowerCase();

function uniqueByKey(papers) {
  const seen = new Set();
  return papers.filter((paper) => {
    const key = keyOf(paper);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Takes one from each list in turn until every list is spent.
function interleave(lists) {
  const queues = lists.map(list => [...list]);
  const out = [];
  while (queues.some(queue => queue.length > 0)) {
    for (const queue of queues) {
      if (queue.length > 0) out.push(queue.shift());
    }
  }
  return out;
}

function groupInOrder(papers, keyFn) {
  const groups = new Map();
  for (const paper of papers) {
    const key = keyFn(paper);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(paper);
  }
  return [...groups.values()];
}

// Within one area: sources take turns, and inside a source its subcategories
// do, so neither a fast source nor a busy subcategory fills the area's share.
function orderWithinArea(papers) {
  const bySource = groupInOrder(papers, paper => paper?.sources?.primary || paper?.provider || '');
  return interleave(bySource.map(list => interleave(groupInOrder(list, paper => paper?.primaryCategory || ''))));
}

function quotaFor(plan, pageSize) {
  const areas = plan?.areas || [];
  return areas.length > 0 ? Math.ceil(pageSize / areas.length) : pageSize;
}

// Deals `slots` more papers out of `pools` (area → ordered papers) in turns,
// each area stopping at `limits[area]`.
function deal(pools, areas, limits, slots) {
  const picked = [];
  const taken = Object.fromEntries(areas.map(area => [area, 0]));
  let dealt = true;
  while (picked.length < slots && dealt) {
    dealt = false;
    for (const area of areas) {
      if (picked.length >= slots) break;
      if (taken[area] >= limits[area] || pools[area].length === 0) continue;
      picked.push(pools[area].shift());
      taken[area] += 1;
      dealt = true;
    }
  }
  return picked;
}

function poolsFor(candidates, areas, excludedKeys) {
  const pools = Object.fromEntries(areas.map(area => [area, []]));
  const spill = [];
  for (const paper of uniqueByKey(candidates)) {
    if (excludedKeys.has(keyOf(paper))) continue;
    const area = areaOfPaper(paper);
    if (area && Object.hasOwn(pools, area)) pools[area].push(paper);
    else spill.push(paper);
  }
  for (const area of areas) pools[area] = orderWithinArea(pools[area]);
  return { pools, spill };
}

/**
 * The page for what has answered so far. Each chosen area stops at its share,
 * `ceil(pageSize / areas)`: an area that has not answered yet keeps its slots,
 * which `extendGuestPage` fills when it does. With no chosen areas the page is
 * the sources' own order, as before.
 */
export function composeGuestPage(candidates, plan, pageSize) {
  const areas = plan?.areas || [];
  if (areas.length === 0) return uniqueByKey(candidates).slice(0, pageSize);
  const { pools } = poolsFor(candidates, areas, new Set());
  const quota = quotaFor(plan, pageSize);
  return deal(pools, areas, Object.fromEntries(areas.map(area => [area, quota])), pageSize);
}

/**
 * The page once every source has settled: `shown` stays exactly as it is, in
 * its order, and the free slots go first to the areas still under their
 * share, then to whichever areas have papers left, and only then to papers
 * from areas nobody chose.
 */
export function extendGuestPage(shown, candidates, plan, pageSize) {
  const current = Array.isArray(shown) ? shown.slice(0, pageSize) : [];
  const areas = plan?.areas || [];
  const shownKeys = new Set(current.map(keyOf).filter(Boolean));
  if (areas.length === 0) {
    const extra = uniqueByKey(candidates).filter(paper => !shownKeys.has(keyOf(paper)));
    return [...current, ...extra].slice(0, pageSize);
  }

  const { pools, spill } = poolsFor(candidates, areas, shownKeys);
  const quota = quotaFor(plan, pageSize);
  const used = Object.fromEntries(areas.map(area => [area, current.filter(paper => areaOfPaper(paper) === area).length]));
  const underShare = deal(pools, areas, Object.fromEntries(areas.map(area => [area, Math.max(0, quota - used[area])])), pageSize - current.length);
  const released = deal(pools, areas, Object.fromEntries(areas.map(area => [area, pageSize])), pageSize - current.length - underShare.length);
  const filled = [...current, ...underShare, ...released];
  return [...filled, ...spill].slice(0, pageSize);
}

/**
 * Whether the first paint can be taken: every chosen area has at least
 * `min(2, share)` papers, so the first page already shows the choice. Without
 * chosen areas, four papers, as before. The caller's per-source budget still
 * bounds the wait when an area never answers.
 */
export function guestPageReady(papers, plan, pageSize) {
  const areas = plan?.areas || [];
  if (areas.length === 0) return papers.length >= 4;
  const needed = Math.min(2, quotaFor(plan, pageSize));
  const counts = {};
  for (const paper of papers) {
    const area = areaOfPaper(paper);
    if (area) counts[area] = (counts[area] || 0) + 1;
  }
  return areas.every(area => (counts[area] || 0) >= needed);
}
