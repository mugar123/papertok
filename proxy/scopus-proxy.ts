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
// Deliberately shorter than the Worker's six-second rung: this proxy has to get
// its answer in before the Worker gives up on it, so a stalled Elsevier comes
// back as a status the Worker can read instead of as the Worker's own timeout.
const UPSTREAM_TIMEOUT_MS = 5000;
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

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

// Compares the SHA-256 digests rather than the values. Digests are always 32
// bytes, so the loop runs the same number of times whatever the caller presented
// -- which is what the previous `if (candidate.length !== expected.length)`
// broke: it returned early, and the time that saved told a caller when it had
// guessed the length of the secret. The comment above it claimed otherwise.
async function secretsMatch(candidate, expected) {
  const [candidateDigest, expectedDigest] = await Promise.all([
    sha256Bytes(candidate),
    sha256Bytes(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= candidateDigest[index] ^ expectedDigest[index];
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
    if (!await secretsMatch(presentedSecret(request), sharedSecret)) return json({ code: 'PROXY_AUTH_REQUIRED' }, 401);
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

    let upstream;
    let body;
    try {
      // One clock for the whole exchange. `AbortSignal.timeout` has no timer to
      // clear, so it stays armed while the body is read: an Elsevier that answers
      // its headers and then stalls is cut at the same mark as one that never
      // answers at all.
      upstream = await fetch(target, { headers: upstreamHeaders, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      body = await upstream.text();
    } catch (error) {
      // A deadline without this would only trade a hang for an uncaught throw,
      // which Deno answers with a bare 500 the Worker cannot tell apart from an
      // Elsevier outage.
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return json({ code: timedOut ? 'SCOPUS_UPSTREAM_TIMEOUT' : 'SCOPUS_UPSTREAM_UNREACHABLE' }, 504);
    }

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
