// PaperTok's Scopus egress, deployed on Deno Deploy.
//
// `api.elsevier.com` resolves to `api.elsevier.com.cdn.cloudflare.net`, and the
// PaperTok report API is a Cloudflare Worker. A Worker subrequest to a hostname
// Cloudflare already serves never leaves Cloudflare's network, and Elsevier
// answers it with `500 GENERAL_SYSTEM_ERROR` -- measurably so, even when the
// request carries no API key at all, while the same request from any other
// network gets a normal answer. No key, token or header fixes that; the request
// has to originate somewhere else. This is that somewhere else.
//
// It is deliberately not a general proxy. It serves one route, demands a bearer
// only the Worker holds, and forwards a bounded set of Scopus parameters that it
// rebuilds itself -- it never accepts a caller-supplied URL. The Elsevier key
// lives here and nowhere else.

const SCOPUS_SEARCH_URL = 'https://api.elsevier.com/content/search/scopus';
const ALLOWED_VIEWS = new Set(['COMPLETE', 'STANDARD']);
const MAX_QUERY_LENGTH = 500;
const MIN_SHARED_SECRET_LENGTH = 32;
// Scopus refuses a start offset beyond 5000 and a count above 25.
const MAX_START = 5000;
const MAX_COUNT = 25;
// Headers the Worker reads to report quota and to quote a request id back to
// Elsevier support. Everything else the upstream sets is dropped.
const PASSTHROUGH_HEADERS = [
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-ELS-ReqId',
  'X-ELS-Status',
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}

// Compares without an early return, so a wrong secret cannot be narrowed down by
// timing the response.
function secretsMatch(candidate, expected) {
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function presentedSecret(request) {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function safeQuery(value) {
  const query = [...String(value || '')]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return query && query.length <= MAX_QUERY_LENGTH ? query : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function createScopusProxy(env) {
  const sharedSecret = String(env.PROXY_SHARED_SECRET || '');
  const apiKey = String(env.ELSEVIER_API_KEY || '');
  const instToken = String(env.ELSEVIER_INST_TOKEN || '');

  return async function handleRequest(request) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/health') {
      return json({
        ok: true,
        configured: Boolean(apiKey) && sharedSecret.length >= MIN_SHARED_SECRET_LENGTH,
        insttoken: Boolean(instToken),
      });
    }

    if (request.method !== 'GET') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (requestUrl.pathname !== '/scopus') return json({ code: 'NOT_FOUND' }, 404);

    // A short or missing shared secret would leave the Elsevier key reachable by
    // anyone who finds this hostname, so it is a configuration failure, not a
    // reason to fall through unauthenticated.
    if (sharedSecret.length < MIN_SHARED_SECRET_LENGTH) return json({ code: 'PROXY_NOT_CONFIGURED' }, 503);
    if (!secretsMatch(presentedSecret(request), sharedSecret)) return json({ code: 'PROXY_AUTH_REQUIRED' }, 401);
    if (!apiKey) return json({ code: 'SCOPUS_NOT_CONFIGURED' }, 503);

    const query = safeQuery(requestUrl.searchParams.get('query'));
    if (!query) return json({ code: 'INVALID_QUERY' }, 400);

    const target = new URL(SCOPUS_SEARCH_URL);
    target.searchParams.set('query', query);
    target.searchParams.set('start', String(boundedInteger(requestUrl.searchParams.get('start'), 0, 0, MAX_START)));
    target.searchParams.set('count', String(boundedInteger(requestUrl.searchParams.get('count'), 10, 1, MAX_COUNT)));
    const view = String(requestUrl.searchParams.get('view') || '').toUpperCase();
    if (ALLOWED_VIEWS.has(view)) target.searchParams.set('view', view);

    const upstreamHeaders = {
      accept: 'application/json',
      'X-ELS-APIKey': apiKey,
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    };
    if (instToken) upstreamHeaders['X-ELS-Insttoken'] = instToken;

    const upstream = await fetch(target, { headers: upstreamHeaders });
    const body = await upstream.text();

    const headers = new Headers({
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The Worker cannot see this environment, so the probe reads it from here.
      'X-PaperTok-Insttoken': instToken ? 'true' : 'false',
    });
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new Response(body, { status: upstream.status, headers });
  };
}

const runtimeEnv = typeof Deno === 'undefined' ? {} : Deno.env.toObject();
const handleRequest = createScopusProxy(runtimeEnv);

// Deno Deploy runs this file the way `deno run` does, so the server has to be
// started here: a bare `export default { fetch }` only listens under
// `deno serve`, and a project deployed that way starts and answers nothing.
// The default export is kept so `deno serve` works too, and both are skipped
// under Node, where the tests import `createScopusProxy` directly.
if (typeof Deno !== 'undefined') Deno.serve(handleRequest);

export default { fetch: handleRequest };
