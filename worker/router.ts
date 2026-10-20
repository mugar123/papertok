import type { UpstreamError } from './provider-runtime.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';

type ProviderError = UpstreamError & { resetAt?: string };
type SourceHandler = (request: Request, env: WorkerEnv, identity?: VerifiedIdentity | null) => Promise<Response>;
import type { WorkerEnv } from './env.ts';

import {
  AIExplanationError,
  peekAIQuota,
  verifyFirebaseAccount,
} from './ai-explanation.ts';
import { handlePaperRewrite } from './ai-rewrite.ts';
import { handlePassageAnnotation } from './ai-annotation.ts';
import { isNanConfigured } from './nan-client.ts';
import {
  EmailNotificationError,
  handleEmailNotificationRequest,
  handleEmailUnsubscribe,
} from './email-notifications.ts';
import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.ts';
import { handlePublicListRequest, PUBLIC_LIST_PATHS, PublicListApiError } from './public-list-api.ts';
import { ACCOUNT_DELETE_PATH, AccountDeletionError, handleAccountDeletionRequest } from './account-deletion.ts';
import { INSTITUTION_PATHS, InstitutionLinkError, handleInstitutionLinkRequest } from './institution-link.ts';
import { INSTITUTION_ACCESS_PATH, InstitutionAccessError, handleInstitutionAccess } from './institution-access.ts';
import { INSTITUTION_SERVICES_PATH, handleInstitutionServices } from './institution-services.ts';
import { isServiceAccountConfigured } from './firestore-admin.ts';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { handleOpenAlex } from './openalex-api.ts';
import { handleCitationGraph } from './citation-graph.ts';
import { handleOpenAccess } from './open-access.ts';
import { handleArxiv } from './arxiv-api.ts';
import { handlePdfProxy } from './pdf-proxy.ts';
import { handlePersonalRecommendations, handleRelated, handleSemanticScholar } from './semantic-scholar.ts';
import { handleScopus, isScopusEgressConfigured } from './scopus-api.ts';
import { handlePhysicsLiterature } from './physics-api.ts';
import { handleShareRoute } from './share-route.ts';
import { handleAIHealth, handleEmailHealth, handleOpenAlexHealth, handleScopusHealth } from './health-api.ts';
import {
  handleBioRxiv,
  handleCore,
  handleEuropePmc,
  handleHuggingFacePapers,
  handleHuggingFaceResources,
  handleICite,
  handleNasa,
  handleOpenReview,
  handleOsti,
  handlePaperFigures,
  handlePubmed,
} from './source-api.ts';

const PROTECTED_PROVIDER_PATHS = new Set([
  '/related',
  '/citation-graph',
  '/sources/core',
  '/sources/physics',
  '/sources/scopus',
]);

// What the router tells a client to wait when the upstream refused without
// saying for how long. Semantic Scholar's 429 carries no `retry-after` (measured
// 2026-09-03) and its window is one second: the introductory key admits one
// request per second and refuses the rest of that second at once, so a minute
// is fifty-nine seconds of a reader waiting for a slot that opened long ago. A
// minute stays the answer everywhere else, where the window really is a minute.
const UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS = Object.freeze<Record<string, string>>({
  '/sources/s2': '2',
  '/related': '2',
  '/recommendations': '2',
});
const DEFAULT_UPSTREAM_RETRY_AFTER_SECONDS = '60';

function upstreamRetryAfter(pathname: string, error: ProviderError) {
  return error?.retryAfter
    || UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS[pathname]
    || DEFAULT_UPSTREAM_RETRY_AFTER_SECONDS;
}

// One mapping for every route that spends a provider. `/sources/*` had it and
// `/related` did not, so the same Semantic Scholar 429 reached the browser from
// one route as `429 UPSTREAM_RATE_LIMITED retry-after` and from the other as
// `502 Related papers unavailable` -- the one shape a client retries at once,
// which is the one thing that makes a rate limit worse.
function upstreamFailureResponse(pathname: string, error: ProviderError, origin: string, env: WorkerEnv, label: string) {
  const isScopus = pathname === '/sources/scopus';
  const rateLimited = error?.status === 429;
  // `AbortSignal.timeout` rejects with a `TimeoutError`, and a stall has no
  // status to relay -- so it gets a name instead of the generic 502 body.
  const timedOut = error?.name === 'TimeoutError';
  const status = rateLimited ? 429 : 502;
  return json({
    error: label,
    ...(rateLimited ? { code: 'UPSTREAM_RATE_LIMITED' } : {}),
    ...(timedOut ? { code: 'UPSTREAM_TIMEOUT' } : {}),
    // For every route, not only Scopus: a 400 we caused and an outage they had
    // both used to leave here as the same 502, and the number that told them
    // apart stayed in `wrangler tail` -- which is how the OpenReview `tcdate`
    // bug went unseen for weeks.
    ...(error?.status ? { upstreamStatus: error.status } : {}),
    ...(isScopus && error?.resetAt ? { resetAt: error.resetAt } : {}),
  }, status, {
    ...corsHeaders(origin, env),
    ...(rateLimited ? { 'retry-after': upstreamRetryAfter(pathname, error) } : {}),
  });
}

// A credential that could not be checked is a refusal, not an outage to route
// around: the protected provider routes answer it the same way.
function providerAuthFailure(error: unknown, origin: string, env: WorkerEnv) {
  const knownError = error instanceof WorkerAuthError;
  const status = knownError ? error.status : 503;
  return json({ code: knownError ? error.code : 'PROVIDER_AUTH_UNAVAILABLE' }, status, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
    ...(status === 429 ? { 'retry-after': '60' } : {}),
  });
}

async function authenticateProtectedProviderRequest(request: Request, env: WorkerEnv, pathname: string) {
  if (!PROTECTED_PROVIDER_PATHS.has(pathname)) return null;
  return verifyFirebaseIdentity(request, env);
}

// What a log line may say about a request: the route's fixed part. The query
// string is never read, `/share/*` keeps no key and `/openalex/*` no id, and a
// segment that is not a lowercase route word ends the route, so a DOI, a
// token or an address never reaches Workers Logs.
export function routeForLog(pathname: string) {
  const segments = pathname.split('/').slice(1, 3);
  if (segments[0] === 'share') return '/share';
  const fixed: string[] = [];
  for (const segment of segments) {
    if (!/^[a-z][a-z0-9-]*$/.test(segment)) break;
    fixed.push(segment);
  }
  return `/${fixed.join('/')}`;
}

const DOMAIN_SOURCE_HANDLERS: Record<string, SourceHandler> = {
  '/sources/biorxiv': handleBioRxiv,
  '/sources/europepmc': handleEuropePmc,
  '/sources/pubmed': handlePubmed,
  '/sources/s2': handleSemanticScholar,
  '/sources/core': handleCore,
  '/sources/osti': handleOsti,
  '/sources/nasa': handleNasa,
  '/sources/physics': handlePhysicsLiterature,
  '/sources/scopus': handleScopus,
  '/sources/openreview': handleOpenReview,
  '/sources/huggingface': handleHuggingFacePapers,
  '/enrich/icite': handleICite,
  '/resources/huggingface': handleHuggingFaceResources,
  '/resources/figures': handlePaperFigures,
};

export async function handleRequest(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin, env),
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  // Cloudflare sirve su propio robots.txt gestionado para cualquier host de
  // una zona, y por defecto dice `Allow: /`. Para una API eso esta al reves:
  // nada enlaza a estas rutas, pero un rastreador que las encuentre gasta los
  // presupuestos de OpenAlex, PubMed y Semantic Scholar, que son globales y no
  // por llamante -- la misma bolsa de la que lee el feed de invitados. Se
  // contesta antes que nada porque un rastreador no manda `origin`.
  //
  // Medido el 2026-09-01: en `api.papertok.app` Cloudflare intercepta
  // /robots.txt ANTES que el Worker, asi que esta ruta solo se ve hoy en
  // `papertok-report-api.*.workers.dev`. No esta rota: entra en vigor en el
  // dominio propio en cuanto se apague el robots.txt gestionado de la zona
  // (panel de Cloudflare, AI Crawl Control). Antes de tocarla, comprueba cual
  // de los dos esta contestando.
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    });
  }
  // The pages a crawler reads for a shared link (worker/share-pages.ts).
  // Ahead of every Origin gate: the caller is Vercel relaying a preview bot
  // or a search engine, which sends none, and nothing here reads a session.
  if (url.pathname.startsWith('/share/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' },
      });
    }
    return handleShareRoute(request, env);
  }
  if (url.pathname === '/notifications/unsubscribe' && ['GET', 'POST'].includes(request.method)) {
    return handleEmailUnsubscribe(request, env);
  }
  if (url.pathname.startsWith('/notifications/')) {
    if (origin && !allowedOrigins(env).has(origin)) return json({ code: 'EMAIL_ORIGIN_NOT_ALLOWED' }, 403);
    try {
      const payload = await handleEmailNotificationRequest(request, env, url.pathname);
      return json(payload, 200, {
        ...corsHeaders(origin, env),
        'cache-control': 'private, no-store',
      });
    } catch (error) {
      const knownError = error instanceof EmailNotificationError;
      return json({ code: knownError ? error.code : 'EMAIL_UNAVAILABLE' }, knownError ? error.status : 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  if (url.pathname === ACCOUNT_DELETE_PATH) {
    if (!origin || !allowedOrigins(env).has(origin)) {
      return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
    }
    try {
      const payload = await handleAccountDeletionRequest(request, env);
      return json(payload, payload.complete ? 200 : 202, {
        ...corsHeaders(origin, env),
        'cache-control': 'private, no-store',
      });
    } catch (error) {
      const known = error instanceof AccountDeletionError || error instanceof WorkerAuthError;
      return json({ code: known ? error.code : 'ACCOUNT_DELETION_FAILED' }, known ? error.status : 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  if (INSTITUTION_PATHS.has(url.pathname)) {
    if (!origin || !allowedOrigins(env).has(origin)) {
      return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
    }
    try {
      const payload = await handleInstitutionLinkRequest(request, env);
      return json(payload, 200, { ...corsHeaders(origin, env), 'cache-control': 'private, no-store' });
    } catch (error) {
      const known = error instanceof InstitutionLinkError || error instanceof WorkerAuthError;
      if (!known) console.error('Institution link failed', error);
      return json({ code: known ? error.code : 'INSTITUTION_LINK_FAILED' }, known ? error.status : 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  if (url.pathname === INSTITUTION_ACCESS_PATH) {
    if (request.method !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED' }, 405, corsHeaders(origin, env));
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    try {
      // Before the cache: the answer is the institution's and shared, but
      // only a signed-in reader may draw on the resolvers behind it.
      await verifyFirebaseIdentity(request, env);
      return await handleInstitutionAccess(request, env);
    } catch (error) {
      const known = error instanceof InstitutionAccessError || error instanceof WorkerAuthError;
      if (!known) console.error('Institution access failed', error);
      return json({ code: known ? error.code : 'ACCESS_LOOKUP_UNAVAILABLE' }, known ? error.status : 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  if (url.pathname === INSTITUTION_SERVICES_PATH) {
    if (request.method !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED' }, 405, corsHeaders(origin, env));
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    try {
      await verifyFirebaseIdentity(request, env);
      return await handleInstitutionServices(request, env);
    } catch (error) {
      const known = error instanceof InstitutionAccessError || error instanceof WorkerAuthError;
      if (!known) console.error('Institution services failed', error);
      return json({ code: known ? error.code : 'ACCESS_LOOKUP_UNAVAILABLE' }, known ? error.status : 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  if (PUBLIC_LIST_PATHS.has(url.pathname)) {
    // Writes to a world-readable collection: an unknown Origin is refused
    // outright rather than merely left without CORS headers.
    if (!origin || !allowedOrigins(env).has(origin)) {
      return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
    }
    try {
      const payload = await handlePublicListRequest(request, env, url.pathname);
      return json(payload, 200, {
        ...corsHeaders(origin, env),
        'cache-control': 'private, no-store',
      });
    } catch (error) {
      const known = error instanceof PublicListApiError || error instanceof WorkerAuthError;
      return json({ code: known ? error.code : 'PUBLISH_FAILED' }, known ? error.status : 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  // One passage, explained in place. Same daily allowance as /ai/rewrite —
  // it is the same model doing the same kind of work, just less of it — so it
  // is deliberately NOT free: a route that spends nothing is a route with no
  // ceiling.
  if (url.pathname === '/ai/annotate') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    try {
      const payload = await handlePassageAnnotation(request, env);
      return json(payload, 200, {
        ...corsHeaders(origin, env),
        'cache-control': 'private, no-store',
      });
    } catch (error) {
      const knownError = error instanceof AIExplanationError;
      return json(
        {
          code: knownError ? error.code : 'AI_UNAVAILABLE',
          ...(knownError && error.quota ? { quota: error.quota } : {}),
        },
        knownError ? error.status : 502,
        { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
      );
    }
  }
  if (url.pathname === '/ai/rewrite') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    try {
      // The handler answers with the response itself rather than a payload to
      // wrap: a rewrite is streamed as NDJSON and its first line has to leave
      // before the last one exists, so there is nothing here to serialize. That
      // is also why CORS goes in as `extraHeaders` — those headers have to be
      // on the streaming response when it is created, not added to a body this
      // function never sees.
      return await handlePaperRewrite(request, env, corsHeaders(origin, env));
    } catch (error) {
      const knownError = error instanceof AIExplanationError;
      return json(
        {
          code: knownError ? error.code : 'AI_UNAVAILABLE',
          ...(knownError && error.quota ? { quota: error.quota } : {}),
        },
        knownError ? error.status : 502,
        { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
      );
    }
  }
  // The one provider route asked with a body, so it is routed ahead of the
  // GET-only gate below. Like the protected routes after that gate, it checks
  // the reader's identity before anything else.
  if (url.pathname === '/recommendations') {
    let identity: VerifiedIdentity;
    try {
      identity = await verifyFirebaseIdentity(request, env);
    } catch (error) {
      return providerAuthFailure(error, origin, env);
    }
    try {
      return await handlePersonalRecommendations(request, env, identity);
    } catch (error) {
      console.error('Personal recommendations failed', error);
      return upstreamFailureResponse('/recommendations', error as ProviderError, origin, env, 'Recommendations unavailable');
    }
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
  if (url.pathname === '/health') {
    return json({
      ok: true,
      aiConfigured: Boolean(env.GEMINI_API_KEY || isNanConfigured(env)),
      openAlexConfigured: Boolean(env.OPENALEX_API_KEY),
      adsConfigured: Boolean(env.NASA_ADS_API_TOKEN),
      scopusConfigured: isScopusEgressConfigured(env),
      // Absent means PubMed runs on NCBI's anonymous 3 req/s rather than 10, so
      // it belongs in the report even though the route works without it.
      pubmedKeyConfigured: Boolean(env.NCBI_API_KEY),
      // Not the same kind of flag as PubMed's, despite the shape. Measured on
      // 2026-08-24, Semantic Scholar's anonymous pool refused 9 of 10 requests
      // from the Worker and 10 of 10 from a residential address, so absent here
      // does not mean "slower": it means `/sources/s2` and `/related` are dead.
      // Present has been the difference between 0/6 and 5/6 since 2026-09-02.
      semanticScholarKeyConfigured: Boolean(env.SEMANTIC_SCHOLAR_API_KEY),
      emailConfigured: Boolean(
        env.NOTIFICATION_STORE
        && ((env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) || env.RESEND_API_KEY),
      ),
      publishingConfigured: isServiceAccountConfigured(env),
      // The `[version_metadata]` binding: which deploy is answering. `tag` is
      // the one given to `wrangler deploy --tag`, and null for an untagged one.
      version: env.CF_VERSION_METADATA
        ? { id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag || null }
        : null,
    }, 200, corsHeaders(origin, env));
  }
  if (url.pathname === '/health/email') {
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    return handleEmailHealth(request, env);
  }
  if (url.pathname.startsWith('/openalex/')) {
    try {
      return await handleOpenAlex(request, env);
    } catch (error) {
      // This was the one route that returned its handler bare. A connection
      // reset or a transient DNS failure rose uncaught, and an uncaught throw
      // carries no `access-control-allow-origin`: the browser sees an opaque
      // CORS error and the 429 relay this route works to preserve is lost.
      console.error('OpenAlex relay failed', error);
      return json({ code: 'OPENALEX_UNREACHABLE' }, 502, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
  }
  if (url.pathname === '/health/openalex') {
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    return handleOpenAlexHealth(request, env);
  }
  if (url.pathname === '/health/scopus') {
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    return handleScopusHealth(request, env);
  }
  // Read-only, and deliberately its own route rather than a field on
  // `/health/ai`: this one is per user and needs a session, and health is
  // public. The reader asks for it when it opens so it can show the remaining
  // daily uses without spending one to find out.
  if (url.pathname === '/ai/quota') {
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    try {
      const account = await verifyFirebaseAccount(request, env);
      return json(await peekAIQuota(env, account.uid, { unlimited: account.unlimitedAI }), 200, {
        ...corsHeaders(origin, env),
        'cache-control': 'private, no-store',
      });
    } catch (error) {
      const knownError = error instanceof AIExplanationError;
      return json(
        { code: knownError ? error.code : 'AI_UNAVAILABLE' },
        knownError ? error.status : 502,
        { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
      );
    }
  }
  if (url.pathname === '/health/ai') {
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
    return handleAIHealth(request, env);
  }
  let protectedIdentity;
  try {
    protectedIdentity = await authenticateProtectedProviderRequest(request, env, url.pathname);
  } catch (error) {
    return providerAuthFailure(error, origin, env);
  }
  if (url.pathname === '/related') {
    try {
      return await handleRelated(request, env, protectedIdentity);
    } catch (error) {
      console.error('Related papers failed', error);
      return upstreamFailureResponse('/related', error as ProviderError, origin, env, 'Related papers unavailable');
    }
  }
  if (url.pathname === '/citation-graph') {
    try {
      return await handleCitationGraph(request, env, protectedIdentity);
    } catch (error) {
      console.error('Citation graph failed', error);
      return json({ error: 'Citation graph unavailable' }, 502, corsHeaders(origin, env));
    }
  }
  if (url.pathname === '/oa') {
    try {
      return await handleOpenAccess(request, env);
    } catch (error) {
      return upstreamFailureResponse('/oa', error as ProviderError, origin, env, 'Open-access lookup unavailable');
    }
  }
  if (url.pathname === '/pdf') {
    try {
      return await handlePdfProxy(request, env);
    } catch (error) {
      console.error('PDF relay failed', error);
      return json({ code: 'PDF_UNAVAILABLE' }, 502, { ...corsHeaders(origin, env), 'cache-control': 'no-store' });
    }
  }
  if (url.pathname === '/arxiv') {
    try {
      return await handleArxiv(request, env);
    } catch (error) {
      console.error('arXiv route failed', error);
      return upstreamFailureResponse('/arxiv', error as ProviderError, origin, env, 'arXiv unavailable');
    }
  }
  if (DOMAIN_SOURCE_HANDLERS[url.pathname]) {
    try {
      return await DOMAIN_SOURCE_HANDLERS[url.pathname](request, env, protectedIdentity);
    } catch (error) {
      console.error(`Specialist source failed: ${url.pathname}`, error);
      const label = url.pathname === '/sources/scopus' ? 'Scopus unavailable' : 'Specialist source unavailable';
      return upstreamFailureResponse(url.pathname, error as ProviderError, origin, env, label);
    }
  }
  return json({ error: 'Not found' }, 404, corsHeaders(origin, env));
}
