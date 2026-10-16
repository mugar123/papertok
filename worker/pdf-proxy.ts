import type { WorkerEnv } from './env.ts';

import { fetchPaperPdfBytes } from './ai-explanation.ts';
import { isAIReadablePdfUrl } from '../src/utils/aiExplanationAccess.js';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { reserveSharedMinuteQuota, serveCached } from './provider-runtime.ts';

const DEFAULT_PDF_GLOBAL_MINUTE_LIMIT = 120;
// The in-app PDF viewer on a touch screen (src/components/PDF/PdfPages.jsx)
// draws the pages itself with pdf.js, because a framed PDF is crippled on
// every touch platform. pdf.js needs the bytes, and arXiv and Europe PMC send
// no CORS headers, so the browser cannot read them directly: this route
// relays them. It is not an open proxy. Only the hosts the AI routes already
// read (`isAIReadablePdfUrl`) are accepted, every redirect is checked against
// the same list, the body must be a PDF and is capped at the AI routes' 8 MB
// (`fetchPaperPdfBytes`), the caller must be the app (Origin required, not
// optional), and a shared per-minute ceiling bounds what misses can cost the
// upstream hosts. A hit costs nothing upstream: the edge keeps a PDF for a day.
const PDF_PROXY_CEILING = Object.freeze({
  namespace: 'pdf',
  variable: 'PDF_GLOBAL_MINUTE_LIMIT',
  fallback: DEFAULT_PDF_GLOBAL_MINUTE_LIMIT,
});
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
  if (cached) return serveCached(cached, origin, env);

  const minute = await reserveSharedMinuteQuota(PDF_PROXY_CEILING, env, origin);
  if (minute.error) return minute.error;

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
