import { CATEGORIES } from '../data/categories.js';

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
