import type { WorkerEnv } from './env.ts';

import { fetchPaperPdfBytes } from './ai-explanation.ts';
import { isAIReadablePdfUrl } from '../src/utils/ai-explanation-access.ts';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { callerSubject } from './caller-quota.ts';
import { serveCached } from './provider-runtime.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

const DEFAULT_PDF_GLOBAL_MINUTE_LIMIT = 120;
// The in-app PDF viewer on a touch screen (src/components/pdf/pdf-pages.tsx)
// draws the pages itself with pdf.js, because a framed PDF is crippled on
// every touch platform. pdf.js needs the bytes, and arXiv and Europe PMC send
// no CORS headers, so the browser cannot read them directly: this route
// relays them. It is not an open proxy. Only the hosts the AI routes already
// read (`isAIReadablePdfUrl`) are accepted, every redirect is checked against
// the same list, the body must be a PDF and is capped at the AI routes' 8 MB
// (`fetchPaperPdfBytes`), the caller must be the app (Origin required, not
// optional), and an atomic per-IP and shared per-minute ceiling bounds what misses can cost the
// upstream hosts. A hit costs nothing upstream: the edge keeps a PDF for a day.
const PDF_PROXY_FETCH_BUDGET_MS = 20_000;
const PDF_PROXY_CACHE_SECONDS = 24 * 60 * 60;
const PDF_PROXY_FAILURE_STATUS = Object.freeze({ not_pdf: 415, too_large: 413, unreachable: 502 });

export async function handlePdfProxy(request: Request, env: WorkerEnv) {
  const origin = request.headers.get('origin') || '';
  if (!origin || !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const noStore = { ...corsHeaders(origin, env), 'cache-control': 'no-store' };
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, { ...noStore, allow: 'GET, OPTIONS' });
  }
  const raw = new URL(request.url).searchParams.get('url') || '';
  let target = '';
  try {
    target = raw.length <= 2_000 ? new URL(raw).toString() : '';
  } catch { /* an unparseable URL is refused below */ }
  if (!target || !isAIReadablePdfUrl(target)) {
    return json({ code: 'PDF_HOST_NOT_ALLOWED' }, 400, noStore);
  }

  const cacheKey = new Request(
    `https://papertok.internal/cache/pdf?url=${encodeURIComponent(target)}`,
    { method: 'GET' },
  );
  const cached = await caches.default.match(cacheKey);
  const now = Date.now();
  const minute = new Date(now).toISOString().slice(0, 16);
  const nextMinute = (Math.floor(now / 60_000) + 1) * 60_000;
  const subject = await callerSubject(request, env, `pdf:${minute}`);
  if (!subject) return json({ code: 'PDF_RATE_LIMIT_NOT_CONFIGURED' }, 503, noStore);
  const configuredLimit = Number.parseInt(env.PDF_GLOBAL_MINUTE_LIMIT || '', 10);
  const quota = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `pdf:${minute}`,
    subject,
    subjectLimit: 30,
    globalLimit: Number.isFinite(configuredLimit)
      ? Math.max(1, Math.min(100_000, configuredLimit)) : DEFAULT_PDF_GLOBAL_MINUTE_LIMIT,
    globalAmount: cached ? 0 : 1,
    expiresAt: nextMinute + 60_000,
  });
  if (!quota.accepted) {
    return json({ code: quota.code ? 'PROVIDER_QUOTA_NOT_CONFIGURED' : 'PROVIDER_RATE_LIMITED' }, quota.code ? 503 : 429, {
      ...noStore,
      'retry-after': String(Math.ceil((nextMinute - now) / 1000)),
    });
  }
  if (cached) return serveCached(cached, origin, env);

  const { bytes, reason } = await fetchPaperPdfBytes(target, PDF_PROXY_FETCH_BUDGET_MS);
  if (!bytes) {
    return json({ code: 'PDF_UNAVAILABLE', reason }, PDF_PROXY_FAILURE_STATUS[reason] || 502, noStore);
  }
  const response = new Response(bytes, {
    status: 200,
    headers: {
      ...corsHeaders(origin, env),
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': `public, max-age=3600, s-maxage=${PDF_PROXY_CACHE_SECONDS}`,
    },
  });
  await caches.default.put(cacheKey, response.clone());
  return response;
}
