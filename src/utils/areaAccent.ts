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
 * The prefix match is the part worth keeping in one place: arXiv category ids
 * are `cs.LG`, `math-ph`, `econ.EM`, and a paper is routinely filed under a
 * subcategory the map does not list explicitly. Splitting on `.` and `-` and
 * matching the area whose subcategories share that prefix is what stops a
 * `cs.NE` paper from falling through to the brand ink.
 */
// The taxonomy, not `categories.ts`: the Worker imports this file to ink the
// email digest, and `categories.ts` attaches the React icons.
import { CATEGORIES, getAreaKeyFromTopicName } from '../data/categoryTaxonomy.ts';

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
    if ((area.subcategories as Record<string, { label: string }>)?.[category]) return key as keyof typeof CATEGORIES;
  }

  const prefix = category.split('.')[0].split('-')[0];
  for (const [key, area] of Object.entries(CATEGORIES)) {
    const subcategories = Object.keys(area.subcategories || {});
    if (subcategories.some(subKey => subKey.startsWith(prefix))) {
      return key as keyof typeof CATEGORIES;
    }
  }
  return null;
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

/*
 * The OpenAlex topics that stand for a leaf arXiv does not serve, for the
 * feed's OpenAlex request (PAP-73). Topics, not subfields: in a blind check on
 * 2026-10-21, newest-first articles from core sources were on the leaf's field
 * in 74 % of 172 results by topic and 53 % of 190 by subfield, because
 * subfields such as 2202 (aerospace) also hold whole neighbouring disciplines.
 * Only leaves checked against returned papers are listed; any other leaf sends
 * no request, as an unchecked list could bring back another field's papers.
 */
const OPENALEX_LEAF_TOPICS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'bio.gen': ['T10015', 'T10261', 'T10012', 'T10120', 'T10269', 'T11642', 'T10222', 'T11468', 'T10676', 'T11764'],
  'bio.mol': ['T10878', 'T10521', 'T10604', 'T11482', 'T10123', 'T12534', 'T10268', 'T11041', 'T11765', 'T11237'],
  'bio.cell': ['T10773', 'T10301', 'T10379', 'T10505', 'T10294', 'T10492', 'T10617', 'T11150', 'T11841', 'T10407'],
  'bio.biochem': ['T10044', 'T10602', 'T10836', 'T10432', 'T10934', 'T11124', 'T11844', 'T12688', 'T10303', 'T11884'],
  'bio.comp': ['T11289', 'T10887', 'T10621', 'T12254', 'T10885', 'T10519', 'T12576'],
  'bio.neuro': ['T10429', 'T10241', 'T10342', 'T10427', 'T10581', 'T10077', 'T10448', 'T10608', 'T10056', 'T10465', 'T10985', 'T10614'],
  'med.neuro': ['T10009', 'T10094', 'T10086', 'T10085', 'T10498', 'T11266', 'T10706', 'T10855', 'T11763', 'T10227', 'T10919', 'T11735'],
  'med.psych': ['T10106', 'T10376', 'T10263', 'T10023', 'T10242', 'T10537', 'T10854', 'T13944', 'T11123', 'T12553', 'T11093', 'T10168'],
  'bio.physio': ['T11109', 'T12005', 'T11456', 'T10814', 'T10155', 'T11204', 'T11193', 'T11968', 'T11399', 'T10441', 'T10745', 'T11209'],
  'civil.env': ['T10753', 'T10016', 'T10210', 'T10139', 'T10197', 'T10419', 'T10324', 'T11781', 'T10564', 'T11231', 'T11188', 'T12120', 'T11624', 'T11108', 'T10284', 'T11952'],
  'bio.eco': ['T10089', 'T10199', 'T10005', 'T10319', 'T10555', 'T10895', 'T10332', 'T10302', 'T11791', 'T10779', 'T11880', 'T10341', 'T10669', 'T12640', 'T12091', 'T11913'],
  'civil.hydro': ['T10930', 'T10330', 'T11186', 'T11119', 'T11490', 'T10577', 'T14232', 'T10894', 'T12543', 'T11312', 'T12022', 'T12293', 'T11220', 'T11634', 'T10969'],
  'mech.aero': ['T10173', 'T10944', 'T11489', 'T11082', 'T12125', 'T11619', 'T11170', 'T11096', 'T12696', 'T11701', 'T12513', 'T11008', 'T12449', 'T12158', 'T12007', 'T12081'],
  'civil.struct': ['T10160', 'T10713', 'T10479', 'T11606', 'T10534', 'T10690', 'T12940', 'T11352', 'T11807', 'T13031', 'T11874', 'T13852', 'T11870', 'T10687', 'T12487'],
});

// OpenAlex takes at most 50 values for one filter key.
const MAX_OPENALEX_FILTER_VALUES = 50;

/**
 * The OpenAlex works filter for the reader's leaves, in preference order: their
 * topic IDs taken in turn from each leaf, so every leaf is represented when the
 * lists hold more than one filter takes, and the work types. Aerospace adds
 * conference papers, 19 of 20 of them on the field in that check (structural
 * engineering: 0 of 2). Null when no leaf has a topic list.
 */
export function openAlexTopicFilterForLeaves(leaves: readonly string[]) {
  const lists = leaves.map(leaf => OPENALEX_LEAF_TOPICS[leaf]).filter(Boolean);
  const longest = Math.max(0, ...lists.map(list => list.length));
  const topics = Array.from({ length: longest }, (_, index) => lists.map(list => list[index]))
    .flat()
    .filter(Boolean)
    .slice(0, MAX_OPENALEX_FILTER_VALUES);
  if (!topics.length) return null;
  const types = leaves.includes('mech.aero') ? 'article|conference-paper' : 'article';
  return `primary_topic.id:${topics.join('|')},type:${types}`;
}

/** The leaves whose topic list holds this OpenAlex topic, given its ID or URL. */
export function leavesForOpenAlexTopic(topic: string | { id?: string } | null | undefined) {
  const id = openAlexId(topic);
  return id ? Object.keys(OPENALEX_LEAF_TOPICS).filter(leaf => OPENALEX_LEAF_TOPICS[leaf].includes(id)) : [];
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
