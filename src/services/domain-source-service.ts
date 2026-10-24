import type { Paper } from '../models/paper.ts';
import type { SettledWithin } from '../utils/async-timing.ts';
type SourceRequest<T> = { path: string; promise: Promise<T> };

import { PaperBuilder } from './paper-builder.ts';
import { isScopusEnabled, ScopusAdapter } from './adapters/scopus-adapter.ts';
import { authenticatedWorkerFetch, hasWorkerSession, sourceResponseError } from './worker-api-client.ts';
import { withRequestDeadline } from '../utils/request-deadline.ts';
import { settleWithin } from '../utils/async-timing.ts';
import {
  DOMAIN_SOURCE_PATHS,
  PROTECTED_SOURCE_PATHS,
  domainSourceRequests,
  getDomainSourcePlan,
  getEligibleDomainSources,
  sourceQuery,
} from './domain-source-records.ts';

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
