import type { WorkerEnv } from './env.ts';

import { checkAIProviderHealth } from './ai-explanation.ts';
import { checkEmailProviderHealth, getEmailDeliveryLedgerHealth, getEmailScheduleHealth } from './email-notifications.ts';
import { corsHeaders, json } from './http.ts';
import { checkOpenAlexHealth } from './openalex-api.ts';
import { canonicalCacheKey, readOpenAlexBudget, serveCached } from './provider-runtime.ts';
import { checkScopusHealth } from './scopus-api.ts';

const EMAIL_HEALTH_CACHE_SECONDS = 5 * 60;
const SCOPUS_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_BUDGET_CACHE_SECONDS = 60;

export async function handleEmailHealth(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  // Brevo shares one rate limit between this probe and real delivery, so the
  // answer is served from the edge cache like its Scopus and OpenAlex
  // siblings: hammering the route cannot make the digests fail.
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
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
// polling cannot crowd the misses. A ledger that cannot be read is not cached.
export async function handleOpenAlexBudget(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
  const budget = await readOpenAlexBudget(env);
  if (!budget.report) {
    return json({ code: budget.code }, 503, { ...corsHeaders(origin, env), 'cache-control': 'no-store' });
  }
  const response = json(budget.report, 200, {
    ...corsHeaders(origin, env),
    'cache-control': `public, max-age=30, s-maxage=${OPENALEX_BUDGET_CACHE_SECONDS}`,
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
  // The probe costs one upstream Scopus call, so it is served from the edge
  // cache: hammering the route cannot drain the weekly provider allowance.
  const cacheKey = canonicalCacheKey(request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);
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
