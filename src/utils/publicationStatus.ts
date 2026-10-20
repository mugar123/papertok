import type { OpenAlexLocation, OpenAlexWork } from '../services/adapters/openAlexTypes.ts';

/**
 * Whether a paper is a preprint, read from what each provider actually says
 * about it (audit 2026-09-23, issue 12a: chapters and accepted papers carried
 * the «Preprint» chip), and whether an OpenAlex record shows peer review.
 */

// An arXiv comment that says the paper was accepted by, or appears in, a
// venue: «Accepted for publication as a book chapter», «To appear as a
// chapter», «Accepted at AAAI» all escaped the old `… in` alone (2607.02734,
// 2608.12077, 2606.06074). «Submitted to» still says nothing of the kind.
const ARXIV_PUBLISHED_COMMENT = /\b(?:(?:accepted|published|appears|to appear) in|accepted (?:for|at|to)|to appear (?:as|at))\b/i;

export function arxivCommentSaysPublished(comment: unknown) {
  return ARXIV_PUBLISHED_COMMENT.test(String(comment || ''));
}

// OpenAlex types a preprint as such; every other type it gives — an article,
// a book chapter, a proceedings paper — is a published work, whatever
// repository its best copy sits in: 8 in 100 random chapters had one as their
// primary location and were labelled preprints for it. A work typed as a
// preprint is still published once any copy of it is the published one. This
// is the rule the enrichment mapper already kept; the card mappers now share it.
const OPENALEX_PREPRINT_TYPES = new Set(['preprint', 'posted-content']);

type OpenAlexStatusFields = Pick<OpenAlexWork, 'type' | 'primary_location' | 'locations'> | null | undefined;

function openAlexType(work: OpenAlexStatusFields) {
  return String(work?.type || '').trim().toLowerCase();
}

export function openAlexPublicationStatus(work: OpenAlexStatusFields) {
  const type = openAlexType(work);
  if (type && !OPENALEX_PREPRINT_TYPES.has(type)) return 'published';
  const published = work?.primary_location?.is_published
    || (Array.isArray(work?.locations) && work.locations.some(location => location?.is_published));
  return published ? 'published' : 'preprint';
}

// OpenAlex has no peer-review field. The evidence it does carry is the venue:
// a journal, a proceedings, or a proceedings series (Lecture Notes in Computer
// Science is a `book series`). A repository, an ebook platform or a missing
// source shows nothing either way, and neither does a venue for an editorial,
// a chapter or a dataset.
const OPENALEX_REVIEWED_TYPES = new Set(['article', 'review', 'conference-paper']);
const OPENALEX_VENUE_SOURCE_TYPES = new Set(['journal', 'conference', 'book series']);

// OpenAlex files many working-paper series as journals and their papers as
// articles. IMF Working Paper (S4210171147), the Fed Board's Finance and
// Economics Discussion Series (S4210212089) and the FRBSF Working Paper Series
// (S4306510381) come back as `article`, in a `journal`, `is_published`,
// `publishedVersion` and CWTS core, exactly like a Nature paper (probed
// 2026-10-19). Only the series' own name says what it is. NBER, CESifo and the
// New York Fed's Staff Reports arrive typed `report` instead.
const WORKING_PAPER_SERIES = /\b(?:working|discussion) papers?\b|\bdiscussion (?:series|notes?)\b/i;

function isWorkingPaperSeries(location: OpenAlexLocation | null | undefined) {
  return WORKING_PAPER_SERIES.test(String(location?.source?.display_name || ''));
}

/**
 * Peer review as far as an OpenAlex record shows it: true when a venue carries
 * the work, false for a preprint, a report or a working-paper series, and
 * undefined when the record shows neither. Every OpenAlex mapper reads it here,
 * because `published` alone also covers working papers.
 */
export function openAlexPeerReviewed(work: OpenAlexStatusFields): boolean | undefined {
  const type = openAlexType(work);
  if (type === 'report' || isWorkingPaperSeries(work?.primary_location)) return false;
  if (OPENALEX_PREPRINT_TYPES.has(type)) {
    if (openAlexPublicationStatus(work) === 'preprint') return false;
  } else if (!OPENALEX_REVIEWED_TYPES.has(type)) {
    return undefined;
  }
  const locations = [work?.primary_location, ...(Array.isArray(work?.locations) ? work.locations : [])];
  const inVenue = locations.some(location => OPENALEX_VENUE_SOURCE_TYPES.has(String(location?.source?.type || ''))
    && !isWorkingPaperSeries(location));
  return inVenue ? true : undefined;
}

// Semantic Scholar's `Review` is a kind of article: PMID 30617335, a review
// in Nature Medicine, carried the chip.
export function semanticScholarIsPreprint(publicationTypes: unknown) {
  return Array.isArray(publicationTypes)
    && publicationTypes.some(type => String(type).trim().toLowerCase() === 'preprint');
}
