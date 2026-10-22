import type { Paper } from '../models/Paper.ts';
import type { OpenAlexWork } from './adapters/openAlexTypes.ts';
import type { SettledWithin } from '../utils/asyncTiming.ts';
type SourceRequest<T> = { path: string; promise: Promise<T> };

import { getCategoryArea } from '../data/categories.ts';
import { PaperBuilder } from './PaperBuilder.ts';
import { isScopusEnabled, ScopusAdapter } from './adapters/ScopusAdapter.ts';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.ts';
import { OPENALEX_WORK_SEARCH_FIELDS } from '../utils/openAlexWork.ts';
import { openAlexJson } from './openAlexClient.ts';
import { openAlexTopicFilterForLeaves } from '../utils/areaAccent.ts';
import { authenticatedWorkerFetch, hasWorkerSession, sourceResponseError } from './workerApiClient.ts';
import { withRequestDeadline } from '../utils/requestDeadline.ts';
import { settleWithin } from '../utils/asyncTiming.ts';
import {
  DOMAIN_SOURCE_PATHS,
  PROTECTED_SOURCE_PATHS,
  domainSourceRequests,
  getDomainSourcePlan,
  getEligibleDomainSources,
  sourceQuery,
} from './domainSourceRecords.ts';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 10_000;
// Per source, and deliberately under the 4 s render budget every caller wraps
// this whole branch in: the inner cut has to win that race, or the outer one
// discards the sources that already answered along with the one that stalled.
// It matches `OPTIONAL_SOURCE_RENDER_BUDGET_MS` in the feed for the same reason.
const DOMAIN_SOURCE_BUDGET_MS = 3_500;

async function fetchJson<T>(path: string, params: Record<string, unknown>): Promise<T | null> {
  if (!PAPER_API_BASE) return null;
  const url = new URL(`${PAPER_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  // One deadline for headers and body alike. These calls run inside the
  // `Promise.allSettled` of `fetchDomainPapers`, so a single source that answers
  // its headers and then stops used to hold the whole feed behind it.
  const options = withRequestDeadline({ headers: { accept: 'application/json' } }, REQUEST_TIMEOUT_MS);
  const response = PROTECTED_SOURCE_PATHS.has(path)
    ? await authenticatedWorkerFetch(url, options)
    : await fetch(url, options);
  if (!response.ok) {
    // Read under the same deadline as the headers (`withRequestDeadline` keeps
    // the signal armed for the body); a body that is not JSON is simply no body.
    const body = await response.json().catch(() => null) as { code?: unknown; upstreamStatus?: number } | null;
    throw sourceResponseError(path, response.status, body);
  }
  return response.json();
}

// `Promise.allSettled` used to drop its rejections on the floor, so a systematic
// 401, a quota 429 and a source that is simply down all reached the feed as the
// same thing: nothing. It is what kept the failing physics branch invisible.
export function reportDomainSourceFailures<T>(settled: SettledWithin<T>[], entries: Array<{ path: string }>, logger = console.warn) {
  settled.forEach((result, index) => {
    const path = entries[index]?.path || 'unknown';
    // A source cut at its budget is not a rejection and used to leave no trace at
    // all -- the same silence that once hid the failing physics branch, in the
    // one shape `allSettled` cannot produce.
    if (result.status === 'timed_out') {
      logger(`Domain source ${path} failed: timed out`);
      return;
    }
    if (result.status !== 'rejected') return;
    const reason = result.reason as { code?: string; message?: string; status?: number } | null;
    // `code` first (it is the discriminant: UPSTREAM_RATE_LIMITED vs
    // PROVIDER_RATE_LIMITED vs UPSTREAM_TIMEOUT), then the message, which since
    // `sourceResponseError` carries the upstream status. The bare status came
    // before the message here, and hid exactly that detail.
    const detail = reason?.code || reason?.message || reason?.status || String(reason);
    logger(`Domain source ${path} failed: ${detail}`, reason);
  });
}

/**
 * Settles every domain source under its own budget instead of one shared with
 * the slowest of them. `Promise.allSettled` resolves only when its last member
 * does, and each caller then wraps this branch in a single render budget -- so
 * an upstream that stalls past that budget used to take the papers its siblings
 * had already returned down with it. bioRxiv hangs outright on about a quarter
 * of calls (measured 2026-09-01), which made that the common case, not the edge.
 */
export async function settleDomainSources<T>(requests: SourceRequest<T>[], sourceBudgetMs = DOMAIN_SOURCE_BUDGET_MS, logger = console.warn) {
  const settled = await Promise.all(
    requests.map(entry => settleWithin(entry.promise, sourceBudgetMs)),
  );
  reportDomainSourceFailures(settled, requests, logger);
  return settled;
}
export async function fetchDomainPapers(categories: readonly string[], page = 1, limit = 8, queryMode = 'recent', { sourceBudgetMs = DOMAIN_SOURCE_BUDGET_MS } = {}) {
  const plan = getDomainSourcePlan(categories);
  const eligible = getEligibleDomainSources(plan, {
    hasSession: hasWorkerSession(),
    scopusEnabled: isScopusEnabled(),
  });
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 8));
  const requests: SourceRequest<Array<Paper | null>>[] = [];

  if (eligible.scopus) {
    const scopusAdapter = new ScopusAdapter();
    requests.push({ path: DOMAIN_SOURCE_PATHS.scopus, promise: scopusAdapter.search(sourceQuery(plan.scopus.slice(0, 4)), safePage, {
      internalCategories: plan.scopus,
      limit: safeLimit,
      sort: queryMode,
    }).then(result => result.papers || []) });
  }
  for (const source of domainSourceRequests(plan, eligible, safePage, safeLimit, queryMode)) {
    requests.push({ path: source.path, promise: fetchJson(source.path, source.params).then(source.read) });
  }

  if (requests.length === 0) return [];
  const settled = await settleDomainSources(requests, sourceBudgetMs);
  return PaperBuilder.deduplicate(
    settled.flatMap(result => result.status === 'fulfilled' ? result.value.filter(Boolean) as Paper[] : [])
  ).slice(0, safeLimit * 2);
}

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
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One page of the series above, newest first, for a reader whose interests
 * include an economics or quantitative-finance category. Any other reader
 * costs no request. The answer does not depend on which of those categories
 * asked, so only the feed calls it, with the reader's own interests:
 * exploration and topic pages would fetch the same series again.
 *
 * The cards come from the OpenAlex mapper, filed under the Economics area and
 * no subcategory: the series say a paper is economics, not which branch.
 * OpenAlex's own field is no better guide here. Of 114 recent works from these
 * series (2026-10-19), it read as Economics or Finance for 58, as Statistics,
 * Medicine, Mathematics, Biology or Computer Science for 17, and as a field
 * the app has no area for, mostly Social Sciences, for 39. A card earns no
 * reader category's preference either: the request is the same whichever
 * category asked, so it is evidence for none of them.
 * The mapper marks a report or a listed series as a working paper, not peer
 * reviewed, so the card shows the Working paper tag. The landing page is the
 * DOI (262 of 262 probed works), and a missing abstract stays missing.
 * A failure rejects, so each feed counts a source that did not answer and
 * fills the page from the others.
 */
export async function fetchWorkingPapers(categories: readonly string[], page = 1): Promise<Paper[]> {
  if (!categories.some(category => ['econ', 'q-fin'].includes(getCategoryArea(category) ?? ''))) return [];
  // A UTC date, so every reader on one day sends the same filter and shares
  // the Worker's cache entry for each page.
  const since = new Date(Date.now() - WORKING_PAPER_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', [
    `primary_location.source.id:${REQUESTED_SERIES_IDS.join('|')}`,
    // The window also held one dataset.
    'type:article|report',
    `from_publication_date:${since}`,
  ].join(','));
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  url.searchParams.set('per-page', String(WORKING_PAPER_PAGE_SIZE));
  url.searchParams.set('select', OPENALEX_WORK_SEARCH_FIELDS.join(','));
  try {
    const data = await openAlexJson<{ results: OpenAlexWork[] }>(url, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      cacheTtlMs: 10 * 60 * 1000,
      staleIfError: true,
      // One attempt per page; the other sources fill a page this one misses.
      retries: 0,
    });
    const adapter = new OpenAlexAdapter();
    return data.results.flatMap((work) => {
      const paper = adapter.mapToStandard(work);
      // The area's own key, which the label and accent lookups read as Economics.
      return paper ? [{ ...paper, primaryCategory: 'econ' }] : [];
    });
  } catch (error) {
    console.warn('Working-paper series unavailable', error);
    throw error;
  }
}

// Each leaf with topics had 1,537 to 10,458 articles with an abstract in the
// 90 days to 2026-10-21, so a longer window would not change the newest pages.
const OPENALEX_TOPIC_WINDOW_DAYS = 90;
const OPENALEX_TOPIC_PAGE_SIZE = 25;

/**
 * One page of the newest articles OpenAlex files under the topics of the
 * reader's leaves (openAlexTopicFilterForLeaves), for leaves arXiv does not
 * serve; a reader without such a leaf costs no request. Core sources only:
 * that drops repository deposits, blogs and stubs, and put 74 % of results on
 * the leaf's field against 65 % without it. No language filter: OpenAlex
 * leaves `language` empty on 14-74 % of these works, mostly English ones.
 *
 * The cards keep OpenAlex's own topic, not the leaf that asked. A failure with
 * no cached copy rejects, with no retry and no wider second request, so the
 * feed counts a source that did not answer and fills the page from the others.
 */
export async function fetchOpenAlexTopicPapers(categories: readonly string[], page = 1): Promise<Paper[]> {
  const topicFilter = openAlexTopicFilterForLeaves(categories);
  if (!topicFilter) return [];
  const now = Date.now();
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', [
    topicFilter,
    // UTC dates, so every reader on one day shares the Worker's cache entry,
    // and none after today: a work dated ahead would sort first.
    `from_publication_date:${day(now - OPENALEX_TOPIC_WINDOW_DAYS * DAY_MS)}`,
    `to_publication_date:${day(now)}`,
    'has_abstract:true',
    'is_retracted:false',
    'primary_location.source.is_core:true',
  ].join(','));
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  url.searchParams.set('per-page', String(OPENALEX_TOPIC_PAGE_SIZE));
  url.searchParams.set('select', OPENALEX_WORK_SEARCH_FIELDS.join(','));
  try {
    const data = await openAlexJson<{ results: OpenAlexWork[] }>(url, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      cacheTtlMs: 10 * 60 * 1000,
      staleIfError: true,
      retries: 0,
      // A main source of the page: ahead of the entity lookups sharing the queue.
      priority: true,
    });
    const adapter = new OpenAlexAdapter();
    return data.results.map(work => adapter.mapToStandard(work)).filter(Boolean) as Paper[];
  } catch (error) {
    console.warn('OpenAlex topic works unavailable', error);
    throw error;
  }
}
