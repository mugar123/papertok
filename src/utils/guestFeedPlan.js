import { CATEGORIES } from '../data/categories.js';
import { guestCategoriesForAreas, normalizeGuestAreas } from './guestInterests.js';

const isDev = import.meta.env?.DEV === true;

/**
 * The guest feed asks four sources at once off this single list, and each one
 * reads it differently: arXiv takes the ids as categories, the OpenAlex
 * discovery query takes the human label, and the domain plan routes by the
 * internal `area.sub` id. So every entry has to exist in the internal schema.
 *
 * `q-bio.NC` did not. It is a real arXiv category but not a PaperTok one -- the
 * schema calls neuroscience `bio.neuro` -- so the label lookup handed its own id
 * back, a billed OpenAlex call went out searching for the literal string
 * "q-bio.NC", and the domain plan matched no biology source at all. Swapping it
 * for `bio.neuro` costs the arXiv branch its exact `cat:` filter (it falls back
 * to a phrase search) and buys a query that means something, plus the bioRxiv
 * and Europe PMC neuroscience sources, which need no session.
 */
export const GUEST_CATEGORIES = Object.freeze([
  'astro-ph.CO',
  'quant-ph',
  'cs.AI',
  'bio.neuro',
  'math.PR',
  'econ.GN',
]);

function warnMissingCategory(categoryId) {
  if (!isDev) return;
  console.warn(
    `[guestFeed] "${categoryId}" is not in the category schema: the discovery query will search for the id itself.`,
  );
}

// Returns the raw id when the schema does not know it -- on purpose. Falling
// back to the area label would paper over the next id that drifts out of the
// schema; the warning is what makes the drift visible while it is still cheap.
export function guestCategoryLabel(categoryId, onMissing = warnMissingCategory) {
  for (const area of Object.values(CATEGORIES)) {
    const category = area.subcategories?.[categoryId];
    if (category) return category.labelEn || category.label || categoryId;
  }
  onMissing(categoryId);
  return categoryId;
}

export function buildGuestDiscoveryQuery(categories = GUEST_CATEGORIES) {
  return categories.map(category => `"${guestCategoryLabel(category)}"`).join(' OR ');
}

/**
 * The areas arXiv can be asked by category. Elsewhere (medicine, biology) an
 * id becomes a phrase search in `fetchPapers`, which is what the signed-in
 * feed avoids with the same list (FeedContext's `arxivAllowedAreas`).
 */
const ARXIV_AREAS = new Set(['physics', 'math', 'cs', 'eess', 'stat', 'econ', 'mech', 'civil', 'chemeng']);
const PUBMED_AREAS = new Set(['bio', 'med']);

// One query each. The signed-in feed sends five categories to arXiv, five to
// OpenAlex and three to PubMed per page; a guest who picked four areas should
// not cost more than a member who picked forty categories.
const GUEST_ARXIV_CAP = 6;
const GUEST_DISCOVERY_CAP = 5;
const GUEST_PUBMED_CAP = 3;

/**
 * Round-robin across areas: the first subcategory of each, then the second,
 * … until `cap`. Every chosen area is represented before any area gets a
 * second seat, so a guest who picked physics and economics does not get six
 * physics categories and no economics.
 */
function interleaveAreaCategories(areas, cap) {
  const lists = areas.map(key => Object.keys(CATEGORIES[key].subcategories));
  const picked = [];
  for (let index = 0; picked.length < cap; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index < list.length && picked.length < cap) {
        picked.push(list[index]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}

/**
 * What the four guest sources are asked, for a guest who picked these areas
 * — or, with none, the fixed sample above.
 *
 * `key` is what the feed hook watches: a plan with the same key is the same
 * plan, and a re-render must not re-fetch.
 */
export function buildGuestFeedPlan(areas = []) {
  const chosen = normalizeGuestAreas(areas);
  if (chosen.length === 0) {
    return Object.freeze({
      key: 'default',
      areas: [],
      categories: [...GUEST_CATEGORIES],
      arxivCategories: [...GUEST_CATEGORIES],
      discoveryQuery: buildGuestDiscoveryQuery(),
      pubmedQuery: 'neuroscience OR bioinformatics',
      pubmedCategories: ['bio.neuro', 'bio.comp'],
    });
  }

  const arxivAreas = chosen.filter(key => ARXIV_AREAS.has(key));
  const pubmedAreas = chosen.filter(key => PUBMED_AREAS.has(key));
  const pubmedCategories = interleaveAreaCategories(pubmedAreas, GUEST_PUBMED_CAP);

  return Object.freeze({
    key: chosen.join('+'),
    areas: chosen,
    categories: guestCategoriesForAreas(chosen),
    arxivCategories: interleaveAreaCategories(arxivAreas, GUEST_ARXIV_CAP),
    discoveryQuery: buildGuestDiscoveryQuery(interleaveAreaCategories(chosen, GUEST_DISCOVERY_CAP)),
    pubmedQuery: pubmedCategories.map(id => `"${guestCategoryLabel(id)}"`).join(' OR '),
    pubmedCategories,
  });
}
