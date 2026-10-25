import type { WorkerEnv } from './env.ts';

import { checkAIProviderHealth } from './ai-explanation.ts';
import { checkEmailProviderHealth, getEmailDeliveryLedgerHealth, getEmailScheduleHealth } from './email-notifications.ts';
import { corsHeaders, json } from './http.ts';
import { checkOpenAlexHealth } from './openalex-api.ts';
import { canonicalCacheKey, readOpenAlexBudget, serveCached } from './provider-runtime.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { checkScopusHealth } from './scopus-api.ts';

const EMAIL_HEALTH_CACHE_SECONDS = 5 * 60;
const SCOPUS_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_BUDGET_CACHE_SECONDS = 60;
const OPENALEX_BUDGET_UNAVAILABLE_CACHE_SECONDS = 10;

// Live probes per cache window, app-wide (Pablo, 2026-10-24). A probe spends a
// paid or rate-limited key outside that provider's own ledger, and the edge
// cache is per data centre with nothing joining concurrent misses: every
// request that arrives while a probe runs would probe too. A few per window
// let the locations real traffic comes from refresh their entry.
const HEALTH_PROBES = {
  email: { windowSeconds: EMAIL_HEALTH_CACHE_SECONDS, limit: 6 },
  openalex: { windowSeconds: OPENALEX_HEALTH_CACHE_SECONDS, limit: 6 },
  scopus: { windowSeconds: SCOPUS_HEALTH_CACHE_SECONDS, limit: 1 },
};

// Null admits the probe. Otherwise the answer is sent without asking the
// provider and is never cached, so the next probe admitted in this location
// refreshes the entry. A missing ledger, or one that answers with an error, is
// a 503: these keys are paid or rate-limited and do not run unledgered. A
// spent window is a 429, like the other ledger refusals, because index.ts
// reports every 5xx to PostHog as an error and a burst would file one each.
async function refuseHealthProbe(probe: keyof typeof HEALTH_PROBES, origin: string, env: WorkerEnv) {
  const { windowSeconds, limit } = HEALTH_PROBES[probe];
  const now = Date.now();
  const window = Math.floor(now / (windowSeconds * 1000));
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `health:${probe}:${window}`,
    subject: `health:${probe}`,
    subjectLimit: limit,
    globalLimit: limit,
  });
  if (reservation.accepted) return null;
  if (reservation.code) {
    return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    });
  }
  return json({ code: 'HEALTH_PROBE_LIMITED' }, 429, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
    // The next window admits probes again.
    'retry-after': String(Math.ceil(((window + 1) * windowSeconds * 1000 - now) / 1000)),
  });
}

export async function handleEmailHealth(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  // Keep provider probes off the hot path and share the result at the edge.
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
  const refused = await refuseHealthProbe('email', origin, env);
  if (refused) return refused;
  const [health, schedule] = await Promise.all([
    checkEmailProviderHealth(env),
    getEmailScheduleHealth(env),
  ]);
  const ledger = getEmailDeliveryLedgerHealth(env);
  const operational = health.available && schedule.fresh && ledger.ok;
  const response = json({ ...health, schedule, ledger }, operational ? 200 : 503, {
    ...corsHeaders(origin, env),
    'cache-control': `public, max-age=60, s-maxage=${EMAIL_HEALTH_CACHE_SECONDS}`,
  });
  try {
    await caches.default.put(cacheKey, response.clone());
  } catch {
    // An uncacheable health response is still a valid answer.
  }
  return response;
}

export async function handleOpenAlexHealth(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
  const refused = await refuseHealthProbe('openalex', origin, env);
  if (refused) return refused;
  const health = await checkOpenAlexHealth(env);
  const response = json(health, health.available ? 200 : 503, {
    ...corsHeaders(origin, env),
    'cache-control': `public, max-age=60, s-maxage=${OPENALEX_HEALTH_CACHE_SECONDS}`,
  });
  try {
    await caches.default.put(cacheKey, response.clone());
  } catch {
    // An uncacheable health response is still a valid answer.
  }
  return response;
}

// Asks OpenAlex nothing: one read of today's ledger object, the object every
// OpenAlex miss already waits on, so the edge keeps the answer a minute and
// polling cannot crowd the misses. A ledger that cannot be read is kept ten
// seconds: still reported as unavailable, and polling an object that is
// already failing stays one read per location every ten seconds.
export async function handleOpenAlexBudget(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
  const budget = await readOpenAlexBudget(env);
  const response = budget.report
    ? json(budget.report, 200, {
      ...corsHeaders(origin, env),
      'cache-control': `public, max-age=30, s-maxage=${OPENALEX_BUDGET_CACHE_SECONDS}`,
    })
    : json({ code: budget.code }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': `public, max-age=0, s-maxage=${OPENALEX_BUDGET_UNAVAILABLE_CACHE_SECONDS}`,
    });
  try {
    await caches.default.put(cacheKey, response.clone());
  } catch {
    // An uncacheable report is still a valid answer.
  }
  return response;
}

export async function handleScopusHealth(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  // The probe costs up to three Scopus calls, one per view it tries. The edge
  // cache spares repeat requests in one location; the probe ceiling is what
  // bounds concurrent misses and the other locations.
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
  const refused = await refuseHealthProbe('scopus', origin, env);
  if (refused) return refused;
  const health = await checkScopusHealth(env);
  const response = json(health, health.available ? 200 : 503, {
    ...corsHeaders(origin, env),
    'cache-control': `public, max-age=60, s-maxage=${SCOPUS_HEALTH_CACHE_SECONDS}`,
  });
  try {
    await caches.default.put(cacheKey, response.clone());
  } catch {
    // An uncacheable health response is still a valid answer.
  }
  return response;
}

export async function handleAIHealth(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  const health = await checkAIProviderHealth(env);
  return json(health, health.available ? 200 : 503, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
  });
}
