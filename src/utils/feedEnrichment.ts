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

/**
 * The page shown from a ranked batch. The corpus gave `notableShare` of its own
 * page to notable cards (`_notable`, worker/paper-store.ts); the page keeps
 * that share of them, as its last cards, and no other notable card.
 */
export function takeFeedPage<T extends Partial<Paper>>(papers: T[] | null | undefined, pageSize = 15, notableShare = 0) {
  const safeSize = Number.isFinite(pageSize) ? Math.max(0, Math.floor(pageSize)) : 15;
  const list = Array.isArray(papers) ? papers : [];
  const notable = list.filter(paper => paper?._notable).slice(0, Math.round(safeSize * notableShare));
  return [...list.filter(paper => !paper?._notable).slice(0, safeSize - notable.length), ...notable];
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
