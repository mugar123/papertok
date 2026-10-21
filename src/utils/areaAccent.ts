import type { Paper } from '../models/Paper.ts';

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
 * The category lookup is the part worth keeping in one place: arXiv category
 * ids are `cs.LG`, `math-ph`, `econ.EM`, and a paper is routinely filed under a
 * subcategory the map does not list explicitly. Such a category (`cs.NE`,
 * `nlin.CD`) takes its area from the taxonomy's archive table, the table that
 * also names its chip, so its ink neither falls back to the brand nor disagrees
 * with the chip.
 */
// The taxonomy, not `categories.ts`: the Worker imports this file to ink the
// email digest, and `categories.ts` attaches the React icons.
import { CATEGORIES, getArxivArchiveArea, getAreaKeyFromTopicName } from '../data/categoryTaxonomy.ts';

const FALLBACK = 'var(--gradient-brand)';

/**
 * The area one category id belongs to, or null.
 *
 * Split out from the ink because the colour was never the only thing anyone
 * wanted from this lookup: a row also needs the field's *name*, and computing
 * it a second way is how a paper ends up inked as physics and labelled as
 * something else.
 */
export function areaKeyForCategory(categoryId: unknown): keyof typeof CATEGORIES | null {
  if (!categoryId || typeof categoryId !== 'string') return null;

  const category = categoryId.trim();
  if (CATEGORIES[category as keyof typeof CATEGORIES]) return category as keyof typeof CATEGORIES;

  for (const [key, area] of Object.entries(CATEGORIES)) {
    if ((area.subcategories as Record<string, { label: string }>)?.[category]) return key as keyof typeof CATEGORIES;
  }

  // Not a prefix match: `math.AC` shares its first letters with `math-ph` and
  // `q-bio.NC` with `quant-ph`, and both were painted as physics.
  return getArxivArchiveArea(category);
}

/** The area one category id belongs to, or null. */
export function areaForCategory(categoryId: unknown) {
  return CATEGORIES[areaKeyForCategory(categoryId) as keyof typeof CATEGORIES] || null;
}

/** The ink for one category id, or the brand ink when nothing matches. */
export function areaAccentForCategory(categoryId: unknown) {
  return areaForCategory(categoryId)?.gradient || FALLBACK;
}

/**
 * OpenAlex's field ids, back to this app's areas.
 *
 * Fields and areas do not map one to one — field 24 feeds both `med` and
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
const OPENALEX_FIELD_AREAS: Readonly<Record<string, keyof typeof CATEGORIES>> = Object.freeze({
  11: 'bio', 13: 'bio',
  15: 'chemeng', 25: 'chemeng',
  17: 'cs',
  18: 'stat',
  20: 'econ',
  22: 'eess',
  24: 'med', 27: 'med', 28: 'med', 29: 'med', 30: 'med', 35: 'med', 36: 'med',
  26: 'math',
  31: 'physics',
});

/*
 * The subfields that belong to a different area than their field. OpenAlex
 * files mechanical, aerospace and civil work under Engineering (22) and
 * finance under Economics, Econometrics and Finance (20), so by field alone
 * they read as Electrical & Electronic Engineering and Economics, and the
 * Explorer's filter for their own area could never find them.
 */
const OPENALEX_SUBFIELD_AREAS: Readonly<Record<string, keyof typeof CATEGORIES>> = Object.freeze({
  2202: 'mech', 2203: 'mech', 2206: 'mech', 2210: 'mech', 2211: 'mech',
  2205: 'civil', 2212: 'civil', 2215: 'civil',
  2003: 'q-fin',
});

function openAlexId(value: string | number | { id?: string } | null | undefined) {
  const raw = typeof value === 'object' ? value?.id : value;
  if (raw === undefined || raw === null) return null;
  return String(raw).split('/').pop()!;
}

/** The area an OpenAlex field belongs to, given its id or its `/fields/17` URL. */
export function areaKeyForOpenAlexField(field: string | number | { id?: string } | null | undefined) {
  const id = openAlexId(field);
  const area = id === null ? null : OPENALEX_FIELD_AREAS[id];
  return (area && CATEGORIES[area]) ? area : null;
}

function areaKeyForOpenAlexTopic(topic: Partial<Paper>['primaryTopic']) {
  const id = openAlexId(topic?.subfield);
  const area = id === null ? null : OPENALEX_SUBFIELD_AREAS[id];
  if (area && CATEGORIES[area]) return area;
  return areaKeyForOpenAlexField(topic?.field);
}

/**
 * The OpenAlex works filter for one area, read from the same tables that name
 * a paper's area, so what the Explorer asks OpenAlex for is what its rows will
 * be labelled. A field filter is a superset when some of its subfields belong
 * elsewhere (Engineering includes mechanical work); the list trims those rows
 * by their label. Null for an area OpenAlex has no field or subfield for.
 */
export function openAlexFilterForArea(areaKey: string | null) {
  const ids = (table: Readonly<Record<string, keyof typeof CATEGORIES>>) => Object.keys(table).filter(id => table[id] === areaKey);
  const fields = ids(OPENALEX_FIELD_AREAS);
  if (fields.length) return `primary_topic.field.id:${fields.join('|')}`;
  const subfields = ids(OPENALEX_SUBFIELD_AREAS);
  if (subfields.length) return `primary_topic.subfield.id:${subfields.join('|')}`;
  return null;
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
export function areaKeyForPaper(paper: Partial<Paper> | null | undefined) {
  const candidates = [paper?.primaryCategory, ...(paper?.categories || [])]
    .filter(value => typeof value === 'string' && value.trim());

  for (const candidate of candidates) {
    const key = areaKeyForCategory(candidate);
    if (key) return key as keyof typeof CATEGORIES;
  }

  // Then the OpenAlex subfield or field. A paper from the works endpoint has
  // no arXiv category at all, and this is the only thing it says about its
  // branch.
  const fieldKey = areaKeyForOpenAlexTopic(paper?.primaryTopic);
  if (fieldKey) return fieldKey;

  /* Last, the topic's own name. A paper can arrive with neither an arXiv
     category nor a field, `categories[0]` being a display name like
     "Wastewater Treatment and Reuse" (the removed Research page's papers all
     did). Without this every such paper resolved to nothing, which is how they
     all came to wear the same accent and the same watermark. */
  for (const candidate of candidates) {
    const key = getAreaKeyFromTopicName(candidate);
    if (key) return key as keyof typeof CATEGORIES;
  }
  return null;
}

/**
 * The area a paper belongs to: its arXiv category if it has one, otherwise the
 * branch OpenAlex filed it under, otherwise what its topic is called.
 */
export function areaForPaper(paper: Partial<Paper> | null | undefined) {
  return CATEGORIES[areaKeyForPaper(paper) as keyof typeof CATEGORIES] || null;
}

/** The ink for a paper. */
export function areaAccentForPaper(paper: Partial<Paper> | null | undefined) {
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
export function areaLabelForPaper(paper: Partial<Paper> | null | undefined) {
  const area = areaForPaper(paper);
  if (area) return area.label || null;
  return paper?.primaryTopic?.field?.display_name || null;
}
