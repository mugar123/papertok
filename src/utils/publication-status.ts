import type { OpenAlexLocation, OpenAlexWork } from '../services/adapters/open-alex-types.ts';

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
// articles. IMF Working Paper, FEDS, the FRBSF and Kansas City Fed series and
// FEDS Notes come back as `article`, in a `journal`, `is_published`,
// `publishedVersion` and CWTS core, exactly like a Nature paper. NBER, CESifo,
// Banco de España and the New York and Philadelphia Fed series arrive typed
// `report`, but CESifo also holds an `article` in its `journal` source
// (W7144132107). Probed 2026-10-19. Only the source ID identifies these series.
const WORKING_PAPER_SOURCE_IDS = new Set([
  'S2809516038', // National Bureau of Economic Research
  'S4210171147', // IMF Working Paper
  'S7407053623', // CESifo
  'S4393913881', // Banco de España, Documentos de Trabajo
  'S4393919745', // Federal Reserve Bank of New York, Staff Reports
  'S4306510381', // Federal Reserve Bank of San Francisco, Working Paper Series
  'S4210230366', // Federal Reserve Bank of Philadelphia, Working Papers
  'S4210212089', // Federal Reserve Board, Finance and Economics Discussion Series
  'S4210173933', // Federal Reserve Bank of Kansas City, Research Working Papers
  'S4210225578', // Federal Reserve Board, FEDS Notes
]);

// A name that says working or discussion paper is not evidence either way:
// 'Working Paper of Public Health' (S4210222596) is a journal. Such a source
// does not count as a venue, so a series missing from the list stays unknown.
const WORKING_PAPER_NAME = /\b(?:working|discussion) papers?\b|\bdiscussion (?:series|notes?)\b/i;

/** Whether an OpenAlex source id (bare or as a URL) is one of the listed working-paper series. */
export function isListedWorkingPaperSeries(sourceId: unknown) {
  return WORKING_PAPER_SOURCE_IDS.has(String(sourceId || '').replace('https://openalex.org/', ''));
}

function isListedSeries(location: OpenAlexLocation | null | undefined) {
  return isListedWorkingPaperSeries(location?.source?.id);
}

function isVenue(location: OpenAlexLocation | null | undefined) {
  return OPENALEX_VENUE_SOURCE_TYPES.has(String(location?.source?.type || ''))
    && !isListedSeries(location)
    && !WORKING_PAPER_NAME.test(String(location?.source?.display_name || ''));
}

/**
 * Whether an OpenAlex record is a working paper or report: typed `report`, or
 * filed under a listed series. Mappers store it as `Paper.workingPaper`, which
 * the card's "Working paper" tag reads.
 */
export function openAlexIsWorkingPaper(work: OpenAlexStatusFields) {
  return openAlexType(work) === 'report' || isListedSeries(work?.primary_location);
}

/**
 * Peer review as far as an OpenAlex record shows it: true when a venue carries
 * the work, false for a preprint, a report or a listed working-paper series,
 * and undefined when the record shows neither. Every OpenAlex mapper reads it
 * here, because `published` alone also covers working papers.
 */
export function openAlexPeerReviewed(work: OpenAlexStatusFields): boolean | undefined {
  if (openAlexIsWorkingPaper(work)) return false;
  const type = openAlexType(work);
  if (OPENALEX_PREPRINT_TYPES.has(type)) {
    if (openAlexPublicationStatus(work) === 'preprint') return false;
  } else if (!OPENALEX_REVIEWED_TYPES.has(type)) {
    return undefined;
  }
  const locations = [work?.primary_location, ...(Array.isArray(work?.locations) ? work.locations : [])];
  return locations.some(isVenue) ? true : undefined;
}

/**
 * No listed series as the primary source, for a list of journal articles
 * that must not hold the series' papers (the harvest's area lanes).
 */
export const OPENALEX_NOT_LISTED_SERIES_FILTER = [...WORKING_PAPER_SOURCE_IDS].map(id => `primary_location.source.id:!${id}`).join(',');

/**
 * The part of `openAlexPeerReviewed` an OpenAlex works filter can express,
 * for a list that keeps only reviewed work: the types the rule can call
 * reviewed, and no listed series as the primary source. Every work it leaves
 * out is one the rule would not call reviewed; the rule still judges the rest
 * (the venue's type, a series named like a working paper). Checked with
 * keyless requests on 2026-10-20: OpenAlex has no `posted-content` type
 * (`group_by=type`), it ANDs each repeated negated source, and a negated
 * source keeps works that have no primary source.
 */
export const OPENALEX_PEER_REVIEWED_FILTER = `type:${[...OPENALEX_REVIEWED_TYPES, 'preprint'].join('|')},${OPENALEX_NOT_LISTED_SERIES_FILTER}`;

// Semantic Scholar's `Review` is a kind of article: PMID 30617335, a review
// in Nature Medicine, carried the chip.
export function semanticScholarIsPreprint(publicationTypes: unknown) {
  return Array.isArray(publicationTypes)
    && publicationTypes.some(type => String(type).trim().toLowerCase() === 'preprint');
}
