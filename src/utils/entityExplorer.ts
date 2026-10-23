import type { Paper, PaperAuthor } from '../models/Paper.ts';

import { isOpenAlexBudgetRefusal } from '../services/openAlexClient.ts';
import { areaKeyForCategory, areaKeyForPaper } from './areaAccent.ts';

function getPaperTimestamp(paper: Partial<Paper>) {
  const timestamp = new Date(paper.published || paper.publicationDate || '').getTime();
  if (Number.isFinite(timestamp)) return timestamp;
  const year = Number(paper.year);
  return Number.isFinite(year) ? new Date(`${year}-01-01T00:00:00Z`).getTime() : 0;
}

// The area a row is labelled with (areaKeyForPaper) is the one the filter
// keeps: an OpenAlex work has no arXiv category, only its topic's subfield and
// field, and matching categories alone dropped every such row. A cross-listed
// arXiv paper also matches the areas of its other categories.
function matchesCategory(paper: Partial<Paper>, areaId: string | undefined) {
  if (!areaId) return true;
  if (areaKeyForPaper(paper) === areaId) return true;
  return [paper.primaryCategory, ...(paper.categories || []), ...(paper.allCategories || [])]
    .some(category => areaKeyForCategory(category) === areaId);
}

/** How many of these papers each area's filter would keep, by area key. */
export function countPapersByArea(papers: Partial<Paper>[], areaKeys: string[]) {
  return Object.fromEntries(areaKeys.map(key => [key, papers.filter(paper => matchesCategory(paper, key)).length]));
}

export function getPaperCitationCount(paper: Partial<Paper> | null | undefined) {
  const candidates = [
    paper?.citationCount,
    paper?.citationsCount,
    paper?.openAlex?.citationCount,
    paper?.openAlex?.cited_by_count,
  ];
  const citationCount = candidates.find(value => Number.isFinite(Number(value)));
  return Math.max(0, Number(citationCount) || 0);
}

export function hasKnownPaperCitationCount(paper: Partial<Paper> | null | undefined) {
  return paper?.citationCountKnown === true
    || paper?.openAlex?.citationCountKnown === true
    || getPaperCitationCount(paper) > 0;
}

export function filterAndSortEntityPapers<T extends Partial<Paper>>(papers: T[], { searchQuery = '', filters = {}, sortBy = '' }: { searchQuery?: string; filters?: { dateRange?: string; category?: string; peerReviewed?: boolean }; sortBy?: string } = {}) {
  const query = searchQuery.trim().toLowerCase();
  const now = new Date();
  const minYear = filters.dateRange === 'last_year'
    ? now.getFullYear() - 1
    : filters.dateRange === 'last_5_years'
      ? now.getFullYear() - 5
      : null;

  const filtered = (papers || []).filter(paper => {
    if (query) {
      const authors = (paper.authors || []).map(author => (author as PaperAuthor)?.name || author).join(' ');
      const searchable = [paper.title, paper.abstract, paper.summary, authors]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(query)) return false;
    }

    if (!matchesCategory(paper, filters.category)) return false;
    // `peerReviewed` is the field `PaperBuilder` writes and every adapter feeds.
    // The filter used to read a differently spelled flag that no paper ever
    // carried, so turning the toggle on emptied the list.
    if (filters.peerReviewed && paper.peerReviewed !== true) return false;
    if (minYear !== null && getPaperTimestamp(paper) < new Date(`${minYear}-01-01T00:00:00Z`).getTime()) return false;
    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sortBy === 'publication_date:desc') return getPaperTimestamp(b) - getPaperTimestamp(a);
    if (sortBy === 'cited_by_count:desc') {
      const citationsA = getPaperCitationCount(a);
      const citationsB = getPaperCitationCount(b);
      return citationsB - citationsA;
    }
    return 0;
  });
}

function normalizePaperId(paperId: string | null) {
  if (!paperId) return '';
  const id = paperId.startsWith('arxiv:') ? paperId.split(':')[1] : paperId;
  return id.replace(/v\d+$/, '');
}

const OPENALEX_AUTHOR_ROUTE = /(?:^|openalex\.org\/)A\d+$/i;
const ORCID_ROUTE = /\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i;
const ARXIV_SOURCE = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

/**
 * Whether an author page is this person rather than whoever the name search
 * returned first: the route names them by OpenAlex id or ORCID, or the paper
 * the link came from confirmed the author (`entity.verified`, set by
 * `getAuthorProfileExact`). A name alone is shared by many people — "Wei
 * Zhang" is 11,284 OpenAlex entities (audit 2026-09-23). Other entity types
 * are identified by their route and always count.
 */
export function authorIdentityVerified({ type, routeId, entity }: { type?: string; routeId?: unknown; entity?: { id?: string; verified?: boolean } | null } = {}) {
  if (type !== 'author') return true;
  const raw = String(routeId || '').trim();
  if (OPENALEX_AUTHOR_ROUTE.test(raw)) return true;
  // An ORCID says who the person is, but a stub (OpenAlex knows no author
  // with it) lists an arXiv search by the name, which is not whose papers
  // those are (review of 2026-09-25).
  if (ORCID_ROUTE.test(raw)) return !String(entity?.id || '').startsWith('stub-');
  return entity?.verified === true;
}

/**
 * The arXiv id of the paper an author was opened from, or '' when the link
 * carried something else. Old links put a PubMed paper's `pmid:` id in
 * `?arxivId=`, and pinning it sent `id_list=pmid:…` to arXiv.
 */
export function sourceArxivIdFrom(value: string|null) {
  const raw = String(value || '').trim();
  return ARXIV_SOURCE.test(raw) ? raw.replace(/v\d+$/i, '') : '';
}

export function pinSourcePaper<T extends Pick<Paper, 'id'>>(papers: T[], sourcePaperId: string | null) {
  const sourceId = normalizePaperId(sourcePaperId);
  if (!sourceId) return papers;
  const sourceIndex = papers.findIndex(paper => normalizePaperId(paper.id) === sourceId);
  if (sourceIndex <= 0) return papers;
  return [papers[sourceIndex], ...papers.slice(0, sourceIndex), ...papers.slice(sourceIndex + 1)];
}

/**
 * What a request for an entity's papers depends on, as one string.
 *
 * The Explorer issues that request from an effect, and an effect cannot tell a
 * re-render from a new request on its own: it re-ran — and its cleanup
 * cancelled whatever was in flight — whenever any dependency changed identity,
 * including the active tab and, for a project, the entity object itself,
 * which is set twice (optimistically from the link, then from its details).
 * Keying the request by the inputs it actually reads lets the effect leave a
 * matching request alone, in flight or already answered.
 *
 * Only the name the request actually reads is part of the key. A project's
 * papers come from OpenAIRE by grant code alone, so no name — the one field
 * that changes between the optimistic entity and the detailed one. A topic's
 * providers are asked with the localized name; every other type passes the
 * entity's own, as the author search phrase or `getWorksByEntity`'s fallback.
 *
 * An institution keys on the route id instead, for the same reason a project
 * skips the name: `entity.id` is the field that changes mid-flight. A
 * search-palette handover hands over a ROR-shaped id (`https://ror.org/<x>`,
 * see explorerHandover.js); `getEntityById` answers with an OpenAlex-shaped
 * one (`mergeInstitutionWithRor` sets `id: openAlexInstitution.id`, in
 * services/rorService.js). Keying on `entity.id` would start a second,
 * differently-filtered request the moment that answer lands —
 * `getWorksByEntity` branches on ROR versus OpenAlex ids, so the two are not
 * the same query — cancelling the one already in flight. The route id never
 * changes mid-flight, and both `getEntityById` and `getWorksByEntity` already
 * accept a ROR id in either shape (a full URL or the bare code), so the one
 * request that starts from it is still the right one.
 */
export function entityPapersRequestKey({
  type,
  id,
  entity,
  entityDisplayName,
  sortBy,
  page,
  searchQuery,
  filters,
  searchParams,
  reloadKey,
  entityReloadKey,
}: { type?: string; id?: string; entity?: { id?: string; display_name?: string; _localTopic?: boolean; _queryTopic?: boolean } | null; entityDisplayName?: string; sortBy?: string; page?: number; searchQuery?: string; filters?: unknown; searchParams?: unknown; reloadKey?: unknown; entityReloadKey?: unknown }) {
  return JSON.stringify([
    type,
    id,
    type === 'institution' ? id : (entity?.id || id),
    type === 'project'
      ? ''
      : ['concept', 'topic'].includes(type!)
        ? entityDisplayName || ''
        : entity?.display_name || '',
    Boolean(entity?._localTopic),
    Boolean(entity?._queryTopic),
    sortBy,
    page,
    searchQuery,
    filters,
    searchParams,
    reloadKey,
    entityReloadKey,
  ]);
}

/**
 * How many rows the Explorer's list mounts at a time.
 *
 * A works page is thirty papers, each row a title and an abstract through the
 * LaTeX splitter and KaTeX, and the page they make is thirteen thousand
 * pixels tall. Mounted in one commit on a phone with the CPU at a quarter
 * speed, that was tasks of 140–220 ms the moment the page answered, with
 * two screens of rows visible and the rest below the fold. Eight rows is two
 * screens; the rest follow in idle chunks, and the "load more" sentinel
 * waits until every row the page already has is in.
 */
export const EXPLORER_ROW_CHUNK = 8;

/** The next row budget: `chunk` more rows, never past what the list has. */
export function nextExplorerRowBudget(budget: number, total: number, chunk = EXPLORER_ROW_CHUNK) {
  return Math.min(Math.max(0, total), Math.max(0, budget) + chunk);
}

/**
 * How many pages the Explorer's list asks for on its own after the reader's
 * last request: after a page its filters emptied, which leaves no foot of the
 * list on screen to ask for the next one, or when that foot is still on
 * screen once a page lands. A reader's request (a new list, scrolling to the
 * foot, or "Keep looking") therefore costs at most this many pages more.
 */
export const EXPLORER_AUTO_PAGES = 2;

/**
 * Whether the list may ask for its next page now: the allowance left after
 * asking, or null when it has to wait for the reader. A reader's request
 * always goes ahead and restores the allowance; the list's own spend it.
 */
export function explorerPageAllowance(autoPagesLeft: number, { byReader }: { byReader: boolean }) {
  if (byReader) return EXPLORER_AUTO_PAGES;
  return autoPagesLeft > 0 ? autoPagesLeft - 1 : null;
}

/**
 * What the Explorer's papers list is once a page has landed with `rows` rows.
 * `rows`: the foot of the list asks for the next page when it comes into
 * view. `looking`: the filters emptied the page and OpenAlex has more, so
 * there is no foot on screen to ask; the list asks for the next page itself,
 * within `explorerPageAllowance`, and then waits for "Keep looking". It is
 * not the empty state. `empty`: no page is left that this reader may load.
 * A visitor gets no second page, so their first page is the whole list.
 */
export function explorerListState({ rows, hasMore, publicMode }: { rows: number; hasMore: boolean; publicMode: boolean }) {
  if (rows > 0) return 'rows';
  return hasMore && !publicMode ? 'looking' : 'empty';
}

/**
 * The error code a failed publications or authors list shows. From 60 % of
 * the day's OpenAlex budget the Worker refuses these lists (PAP-88) while
 * OpenAlex and the reader's connection still work, so that refusal is a pause
 * with its own words, not `failedCode`'s connection advice.
 */
export function explorerListErrorCode(error: unknown, failedCode: string) {
  return isOpenAlexBudgetRefusal(error) ? 'OPENALEX_LIST_PAUSED' : failedCode;
}

/**
 * What somebody without an account is shown of a list, and when to put a door
 * under it. Two rows: enough to see what this entity publishes and how the
 * list reads, short enough that the page is an invitation rather than the
 * whole library.
 */
export const GUEST_PREVIEW_LIMIT = 2;

/** The rows to mount. With a session, the list itself, untouched. */
export function guestPreviewRows<T>(rows: T[], { publicMode }: { publicMode?: boolean } = {}) {
  if (!publicMode) return rows;
  return rows.slice(0, GUEST_PREVIEW_LIMIT);
}

/**
 * Whether the door goes under those rows. Only when something is actually
 * behind it: an entity with two publications has reached its end, not a wall,
 * and a list still loading cannot claim anything is missing yet.
 */
export function shouldShowGuestGate({ publicMode, loaded, hasMore, isLoading }: { publicMode?: boolean; loaded?: number; hasMore?: boolean; isLoading?: boolean } = {}) {
  if (!publicMode || isLoading) return false;
  if (!(loaded! > 0)) return false;
  return loaded! > GUEST_PREVIEW_LIMIT || Boolean(hasMore);
}

/**
 * The count the door is allowed to name — the entity's own publication total,
 * the same number the stats box above already shows. Anything that is not a
 * number, or that does not exceed what is on screen, is no explanation for a
 * wall, so the copy falls back to naming none.
 */
export function guestGateTotal(entity: { works_count?: number | null } | null | undefined, shown = GUEST_PREVIEW_LIMIT) {
  const total = entity?.works_count;
  return Number.isFinite(total) && total! > shown ? total : null;
}

