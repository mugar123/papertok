import { openAlexTopicFilterForLeaves } from './areaAccent.ts';

/*
 * The URLs of the feed's two OpenAlex lanes, the topic lane and the
 * working-paper series. The browser asks for them, and the Worker's nightly
 * prefetch (worker/openalex-prefetch.ts) stores the same URLs in the shared
 * cache, so both build them here. Browser-safe: this module imports only
 * areaAccent.ts, which the Worker already bundles.
 */

// The top-level fields `OpenAlexAdapter.mapToStandard` and `getArxivIdFromWork`
// read, and the only ones a search asks for (`select=`). A works page used to
// arrive whole: 455 KB uncompressed, 65–82 KB on the wire, most of it fields
// nothing here reads (`referenced_works`, `keywords`, `counts_by_year`, the
// second half of `authorships`). Measured 2026-09-16 with this list: 326 KB
// and 45–49 KB. The Worker relays `select` untouched (OPENALEX_PARAMS). Nested
// selection is not something OpenAlex offers, so `authorships` and `locations`
// still travel whole. OpenAlexAdapter.test.ts holds the guard: a work stripped
// to these fields must map to the same paper as the full one.
export const OPENALEX_WORK_SEARCH_FIELDS = Object.freeze([
  'id',
  'doi',
  'ids',
  'title',
  'type',
  'publication_date',
  'publication_year',
  'authorships',
  'abstract_inverted_index',
  'primary_location',
  'locations',
  'open_access',
  'cited_by_count',
  'concepts',
  'topics',
  'primary_topic',
]);

// The series this feed requests, by OpenAlex source ID, each checked with a
// keyless OpenAlex request on 2026-10-19 (PAP-53). The review rule in
// publicationStatus.ts owns which sources are working-paper series. A test
// checks that each ID here is on its list; one that is not would bring its
// articles in as reviewed journal papers without the Working paper tag. That
// list also holds FEDS Notes, short notes rather than working papers, and the
// Kansas City Fed series, which the checks behind this request did not cover.
// OpenAlex types NBER, CESifo, Banco de España and the New York and
// Philadelphia Fed series as `report`, hence `type:article|report` below. World
// Bank Policy Research Working Papers are not listed: OpenAlex files the recent
// ones under the bank's general eBooks source (S4306464317), and its two PRWP
// sources hold nothing from this window.
const REQUESTED_SERIES_IDS = [
  'S2809516038', // National Bureau of Economic Research
  'S4210171147', // IMF Working Papers
  'S7407053623', // CESifo Working Papers
  'S4393913881', // Banco de España, Documentos de Trabajo
  'S4393919745', // Federal Reserve Bank of New York, Staff Reports
  'S4306510381', // Federal Reserve Bank of San Francisco, Working Paper Series
  'S4210230366', // Federal Reserve Bank of Philadelphia, Working Papers
  'S4210212089', // Federal Reserve Board, Finance and Economics Discussion Series
];
// 672 works in the 90 days to 2026-10-19, or 112 pages.
const WORKING_PAPER_WINDOW_DAYS = 90;
// The per-request cap OSTI and NASA have.
const WORKING_PAPER_PAGE_SIZE = 6;
// Each leaf with topics had 1,537 to 10,458 articles with an abstract in the
// 90 days to 2026-10-21, so a longer window would not change the newest pages.
const OPENALEX_TOPIC_WINDOW_DAYS = 90;
const OPENALEX_TOPIC_PAGE_SIZE = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

// UTC dates, so every reader on one day, and the prefetch at 00:05 UTC, send
// the same filter and share the Worker's cache entry for each page.
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

function worksPage(filter: string[], page: number, perPage: number) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', filter.join(','));
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  url.searchParams.set('per-page', String(perPage));
  url.searchParams.set('select', OPENALEX_WORK_SEARCH_FIELDS.join(','));
  return url;
}

/** One page of the working-paper series above, newest first. */
export function openAlexWorkingPapersUrl(page: number, now: number) {
  return worksPage([
    `primary_location.source.id:${REQUESTED_SERIES_IDS.join('|')}`,
    // The window also held one dataset.
    'type:article|report',
    `from_publication_date:${utcDay(now - WORKING_PAPER_WINDOW_DAYS * DAY_MS)}`,
  ], page, WORKING_PAPER_PAGE_SIZE);
}

/**
 * One page of the newest core-source articles under the topics of the given
 * leaves (`openAlexTopicFilterForLeaves`), or null when none of them has a
 * topic list. Core sources only: that drops repository deposits, blogs and
 * stubs, and put 74 % of results on the leaf's field against 65 % without it.
 * No language filter: OpenAlex leaves `language` empty on 14-74 % of these
 * works, mostly English ones.
 */
export function openAlexTopicLaneUrl(leaves: readonly string[], page: number, now: number) {
  const topicFilter = openAlexTopicFilterForLeaves(leaves);
  if (!topicFilter) return null;
  return worksPage([
    topicFilter,
    // None after today: a work dated ahead would sort first.
    `from_publication_date:${utcDay(now - OPENALEX_TOPIC_WINDOW_DAYS * DAY_MS)}`,
    `to_publication_date:${utcDay(now)}`,
    'has_abstract:true',
    'is_retracted:false',
    'primary_location.source.is_core:true',
  ], page, OPENALEX_TOPIC_PAGE_SIZE);
}
