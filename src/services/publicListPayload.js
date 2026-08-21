/**
 * The shape of a public list, and the only place that decides it.
 *
 * This module is pure — no Firebase, no DOM, no network — because BOTH sides
 * of the write need it: the browser uses it for the optimistic UI, and the
 * Cloudflare Worker uses it as the real validation gate before it commits to
 * Firestore with the service identity (F11 in docs/plan/04-PHASES.md).
 *
 * Keeping it in one file is the point. Publishing used to be validated in
 * `firestore.rules`, which could not express it: the rules engine stops at
 * 1000 evaluated expressions per request and a single realistic paper already
 * blew that budget, so publishing was broken outright. The validation moved
 * here, to real code with no such ceiling — which means a second copy of these
 * limits living in the Worker would be a silent way to reintroduce the bug.
 */
import { safeDoiUrl, safeExternalUrl } from '../utils/externalUrl.js';

export const PUBLIC_LIST_LIMITS = Object.freeze({
  papers: 50,
  title: 120,
  description: 600,
  paperTitle: 500,
  abstract: 3000,
  authors: 20,
  author: 160,
  concepts: 12,
  concept: 120,
  id: 300,
  url: 2000,
  doi: 300,
  arxivId: 100,
  category: 120,
  date: 40,
  citations: 1_000_000_000,
});

/**
 * The hard backstop under the 50-paper cap. A Firestore document dies at
 * 1 MiB, and 50 papers each padded to every limit above would come to roughly
 * 550 KB — so the cap alone already keeps a well-formed list clear of the
 * ceiling. This exists for the payload that is not well-formed: it is checked
 * against the serialized document, so a caller cannot slip past the per-field
 * limits by any route and still land a document Firestore would refuse.
 */
export const PUBLIC_LIST_MAX_BYTES = 700_000;

function cleanString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function cleanMultilineString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\r\n?/g, '\n').slice(0, maximum);
}

function normalizeDoi(value) {
  const url = safeDoiUrl(value);
  if (!url) return '';
  try {
    return decodeURI(url.replace('https://doi.org/', ''));
  } catch {
    return '';
  }
}

function normalizeArxivId(value) {
  const candidate = cleanString(value, PUBLIC_LIST_LIMITS.arxivId)
    .replace(/^arxiv:/i, '')
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  return /^(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/i.test(candidate)
    ? candidate
    : '';
}

function normalizeAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map(author => cleanString(
      typeof author === 'string' ? author : author?.name,
      PUBLIC_LIST_LIMITS.author,
    ))
    .filter(Boolean)
    .slice(0, PUBLIC_LIST_LIMITS.authors);
}

function normalizeConcepts(concepts) {
  if (!Array.isArray(concepts)) return [];
  return concepts
    .map(concept => cleanString(
      typeof concept === 'string' ? concept : (concept?.display_name || concept?.name || concept?.title),
      PUBLIC_LIST_LIMITS.concept,
    ))
    .filter(Boolean)
    .slice(0, PUBLIC_LIST_LIMITS.concepts);
}

function stablePaperId(paper, doi, arxivId) {
  const rawId = cleanString(paper?.id, PUBLIC_LIST_LIMITS.id);
  if (doi) return `doi:${doi.toLowerCase()}`;
  if (arxivId) return `arxiv:${arxivId.toLowerCase()}`;
  return rawId;
}

export function sanitizePublicPaper(paper) {
  if (!paper || typeof paper !== 'object') return null;

  const doi = normalizeDoi(paper.doi);
  const arxivId = normalizeArxivId(paper.arxivId || (String(paper.id || '').startsWith('arxiv:') ? paper.id : ''));
  const id = stablePaperId(paper, doi, arxivId);
  const title = cleanString(paper.title, PUBLIC_LIST_LIMITS.paperTitle);
  if (!id || !title) return null;

  const result = {
    id,
    title,
    authors: normalizeAuthors(paper.authors),
  };
  const abstract = cleanMultilineString(paper.abstract || paper.summary, PUBLIC_LIST_LIMITS.abstract);
  const category = cleanString(
    paper.category || paper.primaryCategory || paper.categories?.[0],
    PUBLIC_LIST_LIMITS.category,
  );
  const concepts = normalizeConcepts(paper.concepts);
  const openUrl = safeExternalUrl(
    paper.openUrl || paper.landingPageUrl || paper.openAccessPdfUrl || paper.pdfUrl,
  ).slice(0, PUBLIC_LIST_LIMITS.url);
  const year = Number.isInteger(paper.year) && paper.year >= 1000 && paper.year <= 3000
    ? paper.year
    : null;
  const date = cleanString(paper.date || paper.published, PUBLIC_LIST_LIMITS.date);
  const citations = Number.isInteger(paper.citations)
    ? paper.citations
    : paper.citationCount;

  if (abstract) result.abstract = abstract;
  if (year) result.year = year;
  if (date) result.date = date;
  if (category) result.category = category;
  if (concepts.length) result.concepts = concepts;
  if (Number.isInteger(citations) && citations >= 0 && citations <= PUBLIC_LIST_LIMITS.citations) {
    result.citations = citations;
  }
  if (doi) result.doi = doi;
  if (arxivId) result.arxivId = arxivId;
  if (openUrl) result.openUrl = openUrl;
  return result;
}

export function sanitizePublicList(input) {
  const title = cleanString(input?.title || input?.name, PUBLIC_LIST_LIMITS.title);
  if (!title) throw new TypeError('A public list title is required.');

  const papers = (Array.isArray(input?.papers) ? input.papers : [])
    .map(sanitizePublicPaper)
    .filter(Boolean)
    .slice(0, PUBLIC_LIST_LIMITS.papers);
  const description = cleanMultilineString(input?.description, PUBLIC_LIST_LIMITS.description);

  return {
    title,
    ...(description ? { description } : {}),
    language: input?.language === 'en' ? 'en' : 'es',
    paperCount: papers.length,
    papers,
  };
}

/**
 * The gate the Worker runs before it commits. `sanitizePublicList` coerces —
 * it drops what it cannot clean and never complains — which is right for a
 * form the owner is filling in, and wrong for a request arriving over the
 * network. This re-reads the sanitized result and refuses anything that came
 * out over a limit, so a hostile client cannot hand us a document that only
 * the coercion happened to save.
 */
export function assertPublicListWithinLimits(payload) {
  const failures = [];
  const check = (condition, code) => { if (!condition) failures.push(code); };

  check(typeof payload?.title === 'string' && payload.title.length > 0
    && payload.title.length <= PUBLIC_LIST_LIMITS.title, 'TITLE');
  check(!('description' in payload)
    || payload.description.length <= PUBLIC_LIST_LIMITS.description, 'DESCRIPTION');
  check(payload?.language === 'es' || payload?.language === 'en', 'LANGUAGE');
  check(Array.isArray(payload?.papers)
    && payload.papers.length <= PUBLIC_LIST_LIMITS.papers, 'PAPER_COUNT');
  check(payload?.paperCount === payload?.papers?.length, 'PAPER_COUNT_MISMATCH');

  for (const paper of payload?.papers || []) {
    check(paper.id.length > 0 && paper.id.length <= PUBLIC_LIST_LIMITS.id, 'PAPER_ID');
    check(paper.title.length > 0 && paper.title.length <= PUBLIC_LIST_LIMITS.paperTitle, 'PAPER_TITLE');
    check(Array.isArray(paper.authors)
      && paper.authors.length <= PUBLIC_LIST_LIMITS.authors, 'PAPER_AUTHORS');
    check(paper.authors.every(author => typeof author === 'string'
      && author.length <= PUBLIC_LIST_LIMITS.author), 'PAPER_AUTHOR');
    check(!('abstract' in paper) || paper.abstract.length <= PUBLIC_LIST_LIMITS.abstract, 'PAPER_ABSTRACT');
    check(!('concepts' in paper) || (paper.concepts.length <= PUBLIC_LIST_LIMITS.concepts
      && paper.concepts.every(concept => typeof concept === 'string'
        && concept.length <= PUBLIC_LIST_LIMITS.concept)), 'PAPER_CONCEPTS');
    check(!('openUrl' in paper) || (paper.openUrl.length <= PUBLIC_LIST_LIMITS.url
      && paper.openUrl.startsWith('https://')), 'PAPER_URL');
    check(!('doi' in paper) || paper.doi.length <= PUBLIC_LIST_LIMITS.doi, 'PAPER_DOI');
    check(!('arxivId' in paper) || paper.arxivId.length <= PUBLIC_LIST_LIMITS.arxivId, 'PAPER_ARXIV');
    check(!('category' in paper) || paper.category.length <= PUBLIC_LIST_LIMITS.category, 'PAPER_CATEGORY');
    check(!('date' in paper) || paper.date.length <= PUBLIC_LIST_LIMITS.date, 'PAPER_DATE');
    check(!('year' in paper) || (Number.isInteger(paper.year)
      && paper.year >= 1000 && paper.year <= 3000), 'PAPER_YEAR');
    check(!('citations' in paper) || (Number.isInteger(paper.citations)
      && paper.citations >= 0 && paper.citations <= PUBLIC_LIST_LIMITS.citations), 'PAPER_CITATIONS');
  }

  // The backstop, measured on the wire format rather than on any one field.
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  check(bytes <= PUBLIC_LIST_MAX_BYTES, 'DOCUMENT_TOO_LARGE');

  return failures;
}

/**
 * The same sanitized paper, but keyed by the id the PRIVATE list uses.
 *
 * The background sync (P25) sends `paperIds` — the authoritative membership,
 * in the app's own id namespace — alongside the papers it managed to hydrate,
 * and the Worker joins the two by that id. `sanitizePublicPaper` rewrites ids
 * to their stable `doi:`/`arxiv:` spelling, so the sanitized id is the wrong
 * key: a list holding `2401.12345` would find nothing under `arxiv:2401.12345`
 * and the paper would be dropped from the public copy on every sync.
 *
 * The join key therefore arrives as `listPaperId`, NOT by overwriting `id`,
 * and that distinction is load-bearing. `paperLegacyAdapter` folds the arXiv
 * id into `id` as `arxiv:…` and emits no `arxivId` field at all, so for most
 * hydrated papers **the id is the only carrier of the paper's identity**.
 * Sanitizing a paper whose id had already been swapped for the bare list id
 * measurably stripped `arxivId` from every paper in a real published list and
 * left the public ids bare. Sanitize first, swap the emitted id after: the
 * `doi`/`arxivId` recovered here travel with the paper, so when the Worker
 * sanitizes it again `stablePaperId` lands on exactly the public id it had.
 */
export function sanitizePublicPaperForSync(paper) {
  const clean = sanitizePublicPaper(paper);
  if (!clean) return null;
  const key = cleanString(paper?.listPaperId, PUBLIC_LIST_LIMITS.id) || clean.id;
  return key === clean.id ? clean : { ...clean, id: key };
}

/**
 * The membership the sync declares: deduplicated, in order, and cut to the
 * published cap. The cut is the point — the Worker refuses a merge that
 * resolves to more than `PUBLIC_LIST_LIMITS.papers`, so a 60-paper list has to
 * arrive already trimmed or nothing about it would ever sync again.
 */
export function sanitizeSyncPaperIds(paperIds) {
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(paperIds) ? paperIds : []) {
    const id = cleanString(value, PUBLIC_LIST_LIMITS.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= PUBLIC_LIST_LIMITS.papers) break;
  }
  return ids;
}
