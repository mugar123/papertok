/**
 * A research field's flat ink colour, as a `var(--gradient-*)` reference for
 * `--area-accent`.
 *
 * This was written three times before it was written once. The Explorer had a
 * `getAreaGradient(categoryId)`, the comments sheet had a
 * `getAreaGradient(paper)` that was the same prefix match wrapped in a loop
 * over candidate categories, and the lists page was about to grow a third when
 * its rows learned to carry the field rule. Three copies of a lookup is three
 * chances for one of them to stop matching `PaperCard`, which is the file they
 * are all mirroring and none of them import.
 *
 * The prefix match is the part worth keeping in one place: arXiv category ids
 * are `cs.LG`, `math-ph`, `econ.EM`, and a paper is routinely filed under a
 * subcategory the map does not list explicitly. Splitting on `.` and `-` and
 * matching the area whose subcategories share that prefix is what stops a
 * `cs.NE` paper from falling through to the brand ink.
 */
import { CATEGORIES, getAreaKeyFromTopicName } from '../data/categories.js';

const FALLBACK = 'var(--gradient-brand)';

/**
 * The area one category id belongs to, or null.
 *
 * Split out from the ink because the colour was never the only thing anyone
 * wanted from this lookup: a row also needs the field's *name*, and computing
 * it a second way is how a paper ends up inked as physics and labelled as
 * something else.
 */
export function areaKeyForCategory(categoryId) {
  if (!categoryId || typeof categoryId !== 'string') return null;

  const category = categoryId.trim();
  if (CATEGORIES[category]) return category;

  // Every exact match, before any prefix match — two passes, not one.
  //
  // With both tests inside a single loop the first area to match *either* way
  // won, and the areas are iterated in declaration order. Physics is declared
  // before maths and owns `math-ph`, mathematical physics, whose key starts
  // with "math" — so `math.NT` matched physics by prefix and returned before
  // maths was ever reached, and every number-theory, algebra and topology paper
  // in the app was painted as physics. An exact hit is knowledge; a prefix hit
  // is a guess, and a guess must never outrank knowledge just for being earlier
  // in the list.
  for (const [key, area] of Object.entries(CATEGORIES)) {
    if (area.subcategories?.[category]) return key;
  }

  const prefix = category.split('.')[0].split('-')[0];
  for (const [key, area] of Object.entries(CATEGORIES)) {
    const subcategories = Object.keys(area.subcategories || {});
    if (subcategories.some(subKey => subKey.startsWith(prefix))) {
      return key;
    }
  }
  return null;
}

/** The area one category id belongs to, or null. */
export function areaForCategory(categoryId) {
  return CATEGORIES[areaKeyForCategory(categoryId)] || null;
}

/** The ink for one category id, or the brand ink when nothing matches. */
export function areaAccentForCategory(categoryId) {
  return areaForCategory(categoryId)?.gradient || FALLBACK;
}

/**
 * OpenAlex's field ids, back to this app's areas.
 *
 * The inverse of `REPORT_OPENALEX_FIELDS`, which maps the other way for the
 * report's filters. It is not a bijection — field 24 feeds both `med` and
 * `bio`, 22 feeds three engineering areas — so each id names the area it should
 * be read as when a paper only tells us its field, most specific first.
 *
 * This exists because the Explorer's papers come from OpenAlex's works
 * endpoint, and those carry `primary_topic`, not arXiv categories. Their
 * `categories` array holds concept names — "Toric code", "The Imaginary" —
 * which never match an arXiv prefix, so every row in an author's, an
 * institution's or a project's index rendered in the brand ink, and read
 * "QUBIT" where the feed read "Physics".
 */
const OPENALEX_FIELD_AREAS = Object.freeze({
  11: 'bio', 13: 'bio',
  15: 'chemeng',
  17: 'cs',
  18: 'stat',
  20: 'econ',
  22: 'eess',
  24: 'med', 27: 'med', 28: 'med', 29: 'med', 30: 'med', 35: 'med', 36: 'med',
  26: 'math',
  31: 'physics',
});

/** The area an OpenAlex field belongs to, given its id or its `/fields/17` URL. */
export function areaKeyForOpenAlexField(field) {
  const raw = typeof field === 'object' ? field?.id : field;
  if (raw === undefined || raw === null) return null;
  const area = OPENALEX_FIELD_AREAS[String(raw).split('/').pop()];
  return (area && CATEGORIES[area]) ? area : null;
}

/** The area an OpenAlex field belongs to, given its id or its `/fields/17` URL. */
export function areaForOpenAlexField(field) {
  return CATEGORIES[areaKeyForOpenAlexField(field)] || null;
}

/** The ink for an OpenAlex field. */
export function areaAccentForOpenAlexField(field) {
  return areaForOpenAlexField(field)?.gradient || FALLBACK;
}

/**
 * The area a paper belongs to: its arXiv category if it has one, otherwise the
 * branch OpenAlex filed it under.
 *
 * Papers reach the app from several sources and not all of them fill
 * `primaryCategory`, so a paper whose first listed category is an unrecognised
 * cross-list would otherwise resolve to nothing while the same paper, read from
 * a different feed, resolves to its field.
 */
export function areaKeyForPaper(paper) {
  const candidates = [paper?.primaryCategory, ...(paper?.categories || [])]
    .filter(value => typeof value === 'string' && value.trim());

  for (const candidate of candidates) {
    const key = areaKeyForCategory(candidate);
    if (key) return key;
  }

  // Then the OpenAlex field. A paper from the works endpoint has no arXiv
  // category at all, and this is the only thing it says about its branch.
  const fieldKey = areaKeyForOpenAlexField(paper?.primaryTopic?.field);
  if (fieldKey) return fieldKey;

  /* Last, the topic's own name. Research's papers arrive with neither an arXiv
     category nor a field — `categories[0]` is a display name like "Wastewater
     Treatment and Reuse" — so without this every one of them resolved to
     nothing, which is how they all came to wear the same accent and the same
     watermark. */
  for (const candidate of candidates) {
    const key = getAreaKeyFromTopicName(candidate);
    if (key) return key;
  }
  return null;
}

/**
 * The area a paper belongs to: its arXiv category if it has one, otherwise the
 * branch OpenAlex filed it under, otherwise what its topic is called.
 */
export function areaForPaper(paper) {
  return CATEGORIES[areaKeyForPaper(paper)] || null;
}

/** The ink for a paper. */
export function areaAccentForPaper(paper) {
  return areaForPaper(paper)?.gradient || FALLBACK;
}

/**
 * What to call a paper's branch of science.
 *
 * The kicker used to print `categories[0]` raw, and for anything from OpenAlex
 * that is a concept, not a field: readers got "QUBIT", "Toric code" and "The
 * Imaginary" where the feed said "Physics". Resolving the label through the
 * same chain as the ink means the word and the colour can never disagree.
 *
 * Falls back to OpenAlex's own field name — "Computer Science" — for a branch
 * this app has no area of its own for, and to null when there is nothing to say.
 */
export function areaLabelForPaper(paper, { english = false } = {}) {
  const area = areaForPaper(paper);
  if (area) return (english ? area.labelEn : area.label) || area.labelEn || area.label || null;
  return paper?.primaryTopic?.field?.display_name || null;
}
