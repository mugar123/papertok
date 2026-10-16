import { checkAIProviderHealth } from './ai-explanation.js';
import { checkEmailProviderHealth, getEmailDeliveryLedgerHealth, getEmailScheduleHealth } from './email-notifications.js';
import { corsHeaders, json } from './http.js';
import { checkOpenAlexHealth } from './openalex-api.js';
import { canonicalCacheKey, serveCached } from './provider-runtime.js';
import { checkScopusHealth } from './scopus-api.js';

const EMAIL_HEALTH_CACHE_SECONDS = 5 * 60;
const SCOPUS_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_HEALTH_CACHE_SECONDS = 10 * 60;

export async function handleEmailHealth(request, env) {
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

export async function handleOpenAlexHealth(request, env) {
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

export async function handleScopusHealth(request, env) {
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

export async function handleAIHealth(request, env) {
  const origin = request.headers.get('origin') || '';
  const health = await checkAIProviderHealth(env);
  return json(health, health.available ? 200 : 503, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
  });
}
