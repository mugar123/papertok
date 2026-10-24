import type { Paper } from '../models/Paper.ts';

import { PaperBuilder } from '../services/PaperBuilder.ts';
import { hasUsableAIAbstract } from './aiExplanationAccess.ts';
import { areaKeyForPaper } from './areaAccent.ts';
import { normalizeArxivId, normalizeDoi } from './publicNavigation.ts';

export function getMissingArxivAbstractIds(papers: Paper[]) {
  return [...new Set(papers
    .filter(paper => paper.sources.primary === 'openalex' && !hasUsableAIAbstract(paper.abstract))
    .map(paper => normalizeArxivId(paper.arxivId).replace(/v\d+$/, ''))
    .filter(Boolean))].sort();
}

// INSPIRE indexes high-energy physics and neighbouring fields; the medicine and
// economics DOIs sampled for PAP-51 had no INSPIRE record.
export function getMissingAbstractDois(papers: Paper[]) {
  return [...new Set(papers
    .filter(paper => paper.sources.primary === 'openalex'
      && !hasUsableAIAbstract(paper.abstract) && !normalizeArxivId(paper.arxivId)
      && areaKeyForPaper(paper) === 'physics')
    .map(paper => normalizeDoi(paper.doi)).filter(Boolean))].sort();
}

/**
 * Cards without an abstract that a request still running can supply one for:
 * OpenAlex enrichment, Europe PMC by PubMed ID, or recovery from arXiv or INSPIRE.
 */
export function abstractsInFlight(papers: Paper[], running: { openAlex: boolean; europePmc: boolean; recovery: boolean }) {
  return new Set(papers.filter(paper => !hasUsableAIAbstract(paper.abstract) && (
    (running.openAlex && needsOpenAlexEnrichment(paper))
    || (running.europePmc && Boolean(paper.pmid))
    || (running.recovery && (getMissingArxivAbstractIds([paper]).length > 0 || getMissingAbstractDois([paper]).length > 0))
  )).map(paper => paper.id));
}

export function mergeFeedAbstracts(papers: Paper[], records: Partial<Paper>[]) {
  const abstracts = new Map(records
    .filter(paper => paper.sources?.primary === 'arxiv')
    .filter(paper => hasUsableAIAbstract(paper.abstract))
    .map(paper => [normalizeArxivId(paper.arxivId).replace(/v\d+$/, ''), paper.abstract]));
  const doiAbstracts = new Map(records
    .filter(paper => paper.sources?.primary === 'inspire' && hasUsableAIAbstract(paper.abstract))
    .map(paper => [normalizeDoi(paper.doi), paper.abstract]));
  let changed = false;
  const merged = papers.map(paper => {
    if (paper.sources.primary !== 'openalex' || hasUsableAIAbstract(paper.abstract)) return paper;
    const id = normalizeArxivId(paper.arxivId).replace(/v\d+$/, '');
    const arxivAbstract = id && abstracts.get(id);
    const doi = normalizeDoi(paper.doi);
    const abstract = arxivAbstract || (doi && doiAbstracts.get(doi));
    if (!abstract) return paper;
    changed = true;
    // Recovery supplies only text; it must not replace publication or access metadata.
    return PaperBuilder.merge(paper, { abstract }, arxivAbstract ? 'arxiv' : 'inspire');
  });
  return changed ? merged : papers;
}

export function getOpenAlexEnrichmentId(paperOrId: string | Partial<Paper> | null | undefined) {
  const candidates = typeof paperOrId === 'string'
    ? [paperOrId]
    : [paperOrId?.id, paperOrId?.arxivId];

  for (const value of candidates) {
    if (!value) continue;
    const rawId = /^(?:arxiv|openalex):/i.test(value) ? value.split(':')[1] : value;
    const normalized = rawId.replace(/v\d+$/, '');
    if (/^W\d+$/i.test(normalized)) return `openalex:${normalized}`;
    if (/^\d{4}\.\d{4,5}$/.test(normalized) || /^[a-z][a-z.-]+\/\d{7}$/i.test(normalized)) {
      return normalized;
    }
  }

  // Last, because the identifiers above are better routes to the same work: the
  // arXiv landing-page filter found 5 of 5 measured papers where the DOI route
  // missed one. But a paper that is on neither -- a NASA ADS record, say --
  // used to be unenrichable, and OpenAlex often has it under the DOI its
  // journal issued. The arXiv pseudo-DOI is skipped: it is the arXiv id again.
  const doi = normalizeEnrichmentDoi(typeof paperOrId === 'string' ? '' : paperOrId?.doi);
  if (doi) return `doi:${doi}`;

  return '';
}

function normalizeEnrichmentDoi(value: unknown) {
  const doi = String(value || '').trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(doi) || /^10\.48550\/arxiv\./.test(doi)) return '';
  return doi;
}

export function needsOpenAlexEnrichment(paper: Partial<Paper> | null | undefined) {
  const id = getOpenAlexEnrichmentId(paper);
  if (!id || !(/^(?:openalex:)?W\d+$/i.test(id) || /^\d{4}\.\d{4,5}$/.test(id) || /^[a-z][a-z.-]+\/\d{7}$/i.test(id) || /^doi:/.test(id))) {
    return false;
  }

  const sources: Partial<Paper['sources']> = paper?.sources || {};
  return sources.primary !== 'openalex' && !(sources.enrichedBy || []).includes('openalex');
}

// One feed card in NOTABLE_EVERY is a notable paper the reader has not seen,
// when one is left (Pablo, 2026-10-23): the last card of every NOTABLE_EVERY,
// counted from the last notable card shown, or from the feed's first card.
// The corpus adds unseen ones after a page's own papers (worker/paper-store.ts)
// and the app places them, so the count holds whatever size a page is.
export const NOTABLE_EVERY = 15;

// The cards since the last notable one, up to its place: when more have
// passed, the next card takes that place, late rather than a place later.
const cardsSinceNotable = (cardsBefore: ReadonlyArray<Partial<Paper>>) => Math.min(
  NOTABLE_EVERY - 1,
  cardsBefore.length - 1 - cardsBefore.findLastIndex(paper => paper?._notable),
);

// The first of the feed's `cards` a page's notable places may move: after the
// last notable card and the `reached` first cards, those the reader is on or
// about to reach.
const firstMovable = (cards: ReadonlyArray<Partial<Paper>>, reached: number) => Math.max(
  Math.min(reached, cards.length),
  cards.findLastIndex(paper => paper?._notable) + 1,
);

/**
 * How many notable places a page of up to `others` other cards has after the
 * feed's `cardsBefore` (`joinNotablePage`): a place follows every
 * NOTABLE_EVERY - 1 other cards.
 */
export function notablePlaces(cardsBefore: ReadonlyArray<Partial<Paper>>, others: number, reached = cardsBefore.length) {
  const from = firstMovable(cardsBefore, reached);
  return Math.floor((cardsSinceNotable(cardsBefore.slice(0, from)) + cardsBefore.length - from + Math.max(0, others)) / (NOTABLE_EVERY - 1));
}

/**
 * The page shown after the feed's `cardsBefore`: every other card, in order,
 * with the notable cards (`_notable`), in theirs, at the places: every
 * NOTABLE_EVERY-th card since the last notable one, the place right after the
 * page's last card included, and the page's first card when the feed has
 * passed a place. A place with no notable card left takes the next other
 * card, and a notable card with no place is left out.
 */
export function placeNotableCards<T extends Partial<Paper>>(others: T[], notable: T[], cardsBefore: ReadonlyArray<Partial<Paper>> = []) {
  const since = cardsSinceNotable(cardsBefore);
  const left = [...notable];
  const page: T[] = [];
  const atPlace = () => (since + page.length + 1) % NOTABLE_EVERY === 0;
  for (const paper of others) {
    if (atPlace() && left.length) page.push(left.shift()!);
    page.push(paper);
  }
  if (others.length && atPlace() && left.length) page.push(left.shift()!);
  return page;
}

/**
 * The feed's `cards` with a page joined (`placeNotableCards`). The other
 * cards after the last notable card, past the `reached` ones, are placed
 * again before the page's: related papers a like inserted, or a notable book
 * that left, can leave a place among them with no notable card, and the
 * page's first notable card takes it.
 */
export function joinNotablePage<T extends Partial<Paper>>(cards: T[], others: T[], notable: T[], reached = cards.length) {
  const from = firstMovable(cards, reached);
  const before = cards.slice(0, from);
  return [...before, ...placeNotableCards([...cards.slice(from), ...others], notable, before)];
}

/**
 * `cards` with their other cards replaced by `others` and their notable cards
 * by `notable`, each in order, in the places of their kind. A notable place
 * already counts the cards the reader meets before it, and a count of the list
 * can miss one: a card the reader dismissed leaves the list, not their count.
 * A notable place with no notable card left takes the next other card. Once
 * the other cards run out, no place after them is filled, so a notable card
 * there leaves; other cards left over follow the last place.
 */
export function keepNotablePlaces<T extends Partial<Paper>>(cards: T[], others: T[], notable: T[]) {
  const otherCards = [...others];
  const notableCards = [...notable];
  const kept: T[] = [];
  for (const card of cards) {
    if (card._notable && notableCards.length) kept.push(notableCards.shift()!);
    else if (otherCards.length) kept.push(otherCards.shift()!);
    else break;
  }
  return [...kept, ...otherCards];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// PaperBuilder.merge always allocates a fresh top-level object (and
// sometimes fresh nested objects/arrays, e.g. `sources`, `iciteMetrics`,
// `openAlex`) even when every value it computes is identical to what the
// paper already had — a re-fetch of the same upstream record is a common
// way to hit this. A reference check (`===`) can't tell that apart from a
// real change, so this walks values instead. Anything it can't confidently
// prove equal (functions, class instances, mismatched shapes) is treated as
// different, so a real change is never mistaken for a no-op and dropped.
export function paperFieldsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => paperFieldsEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length
      && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && paperFieldsEqual(a[key], b[key]));
  }
  return false;
}

export function mergeOpenAlexEnrichment(papers: Paper[], enrichmentById: Record<string, Partial<Paper>> | null | undefined) {
  if (!enrichmentById || Object.keys(enrichmentById).length === 0) return papers;

  return papers.map((paper) => {
    const enrichment = enrichmentById[getOpenAlexEnrichmentId(paper)];
    if (!enrichment) return paper;
    const merged = PaperBuilder.merge(paper, enrichment, 'openalex');
    // Identity matters as much as content here: memo(PaperCard) and its
    // IntersectionObserver (PaperCard.jsx:370, keyed on `paper`) only survive
    // a late enrichment pass if a no-op merge hands back the exact same
    // object paper had before, not just a freshly-built lookalike.
    return paperFieldsEqual(merged, paper) ? paper : merged;
  });
}

/**
 * The cards an enrichment pass gave their first OpenAlex topic, as they now
 * read. `after` is `before` merged, card for card in the same order. A copy
 * stored from one of these cards before the pass has no topic (PAP-60, D6).
 */
export function cardsGivenTopic(before: Paper[], after: Paper[]) {
  return after.filter((paper, index) => paper.primaryTopic
    && paper.id === before[index]?.id && !before[index].primaryTopic);
}

// Metadata can arrive after admission; the text the reader saw must stay stable.
// Only a card in `loading`, which says its abstract is on the way, may receive one.
export function preserveFeedAbstracts(current: Paper[], enriched: Paper[], loading: ReadonlySet<string> = new Set()) {
  if (current === enriched) return current;
  return enriched.map((paper, index) => {
    const previous = current[index];
    if (paper.abstract === previous.abstract && paper.summary === previous.summary) return paper;
    if (loading.has(previous.id) && !hasUsableAIAbstract(previous.abstract) && hasUsableAIAbstract(paper.abstract)) return paper;
    const stable = { ...paper, abstract: previous.abstract, summary: previous.summary };
    return paperFieldsEqual(stable, previous) ? previous : stable;
  });
}
