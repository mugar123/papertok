import type { Paper } from '../models/paper.ts';

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
import { CATEGORIES, getArxivArchiveArea } from '../data/category-taxonomy.ts';
import { OPENALEX_LEAF_TOPICS } from '../data/open-alex-leaf-topics.generated.ts';
import { OPENALEX_NOTABLE_LEAF_TOPICS } from '../data/open-alex-notable-leaf-topics.generated.ts';
import { OPENALEX_FIELD_AREAS, OPENALEX_SUBFIELD_AREAS } from '../data/open-alex-areas.ts';

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
  if (Object.hasOwn(CATEGORIES, category)) return category;

  for (const [key, area] of Object.entries(CATEGORIES)) {
    if (Object.hasOwn(area.subcategories, category)) return key;
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

/*
 * OPENALEX_LEAF_TOPICS holds the OpenAlex topics whose newest articles from
 * core sources stand for a leaf, for the harvest's journal-article lane
 * (PAP-73, PAP-99): the leaves arXiv does not serve, and arXiv's own, which
 * otherwise show only preprints. Topics, not subfields: in a blind check on
 * 2026-10-21, newest-first articles from core sources were on the leaf's field
 * in 74 % of 172 results by topic and 53 % of 190 by subfield, because
 * subfields such as 2202 (aerospace) also hold whole neighbouring disciplines.
 * Only leaves checked against returned papers are listed; any other leaf sends
 * no request, as an unchecked list could bring back another field's papers.
 * scripts/generate-openalex-leaf-topics.ts writes the map and admits a new leaf
 * only when its labelled sample passes, with the topics found on target in it.
 */
/**
 * The OpenAlex works filter for one leaf's lane: its topic IDs, sorted, the
 * order the admission gate sampled them in; and the work types. Aerospace adds
 * conference papers, 19 of 20 of them on the field in that check (structural
 * engineering: 0 of 2). Null when the leaf has no topic list.
 */
export function openAlexTopicFilterForLeaf(leaf: string) {
  const topics = OPENALEX_LEAF_TOPICS[leaf];
  if (!topics) return null;
  const types = leaf === 'mech.aero' ? 'article|conference-paper' : 'article';
  return `primary_topic.id:${[...topics].sort().join('|')},type:${types}`;
}

/**
 * The works filter for one leaf's notable lane (ENG-129): the topic lane's
 * filter when the leaf has one, as the most-cited articles of the topics the
 * gate found on target; otherwise the topics the notable sample found on
 * target, articles only (OPENALEX_NOTABLE_LEAF_TOPICS, the second map the
 * generator writes, from a blind sample of the 15 most cited of the ten
 * completed years, the lane's own population); null when neither sample
 * admitted the leaf.
 */
export function openAlexNotableFilterForLeaf(leaf: string) {
  const topics = OPENALEX_NOTABLE_LEAF_TOPICS[leaf];
  return openAlexTopicFilterForLeaf(leaf) ?? (topics ? `primary_topic.id:${[...topics].sort().join('|')},type:article` : null);
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
    if (key) return key;
  }

  // Then the OpenAlex subfield or field. A paper from the works endpoint has
  // no arXiv category at all, and this is the only thing it says about its
  // branch. Nothing after it: the concept and topic names a paper also
  // carries were once read for keywords, and "Somatic cell nuclear transfer"
  // made a Genetics paper Physics (PAP-60).
  return areaKeyForOpenAlexTopic(paper?.primaryTopic);
}

/**
 * The area a paper belongs to: its arXiv category if it has one, otherwise the
 * branch OpenAlex filed it under.
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
 * Falls back to OpenAlex's own field name — "Chemistry", "Social Sciences" —
 * for a field this app has no area of its own for, which then has no field's
 * ink either, and to null when there is nothing to say.
 */
export function areaLabelForPaper(paper: Partial<Paper> | null | undefined) {
  const area = areaForPaper(paper);
  if (area) return area.label || null;
  return paper?.primaryTopic?.field?.display_name || null;
}
