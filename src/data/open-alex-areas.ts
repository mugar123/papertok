import type { CATEGORIES } from './category-taxonomy.ts';

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
export const OPENALEX_FIELD_AREAS: Readonly<Record<string, keyof typeof CATEGORIES>> = Object.freeze({
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
export const OPENALEX_SUBFIELD_AREAS: Readonly<Record<string, keyof typeof CATEGORIES>> = Object.freeze({
  2202: 'mech', 2203: 'mech', 2206: 'mech', 2210: 'mech', 2211: 'mech',
  2205: 'civil', 2212: 'civil', 2215: 'civil',
  2003: 'q-fin',
});

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
