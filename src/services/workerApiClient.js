import { auth } from './firebase.js';
import { withRequestDeadline } from '../utils/requestDeadline.js';

// El Worker responde en los dos: `api.papertok.app` es el Custom Domain, y
// `*.workers.dev` sigue siendo su ruta nativa. Los dos se admiten porque el
// valor que llega aqui viene de una variable de GitHub Actions que cambia sin
// commit: si solo se admitiera el nuevo, un despliegue hecho antes de tocar la
// variable enviaria un bundle que no alcanza ningun backend.
const PRODUCTION_WORKER_ORIGINS = Object.freeze([
  'https://api.papertok.app',
  'https://papertok-report-api.papertok-mugar123.workers.dev',
]);

function configuredWorkerOrigin() {
  const configured = import.meta.env?.VITE_PAPER_API_BASE_URL;
  if (!configured) return '';
  try {
    const url = new URL(configured);
    const isLocalDevelopment = import.meta.env?.DEV
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && ['http:', 'https:'].includes(url.protocol);
    return PRODUCTION_WORKER_ORIGINS.includes(url.origin) || isLocalDevelopment ? url.origin : '';
  } catch {
    return '';
  }
}

export function trustedWorkerUrl(input) {
  const allowedOrigin = configuredWorkerOrigin();
  if (!allowedOrigin) return '';
  try {
    const url = new URL(input);
    if (url.origin !== allowedOrigin || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

// `authenticatedWorkerFetch` throws before the request leaves the browser when
// there is no session, and a caller that swallows rejections cannot tell that
// apart from a source with no results. Anyone who can choose not to ask needs to
// be able to check first -- and to check it the same way everywhere.
export function hasWorkerSession() {
  return Boolean(auth?.currentUser);
}

export class WorkerApiAuthError extends Error {
  constructor(code = 'WORKER_AUTH_REQUIRED') {
    super(code);
    this.name = 'WorkerApiAuthError';
    this.code = code;
  }
}

// The Worker's own origin, for callers that build a route URL rather than being
// handed one. Exported as a builder rather than as the bare origin so no caller
// has to remember the trailing-slash and empty-value handling.
export function workerSourceUrl(path, params = {}, apiBase = configuredWorkerOrigin()) {
  if (!apiBase) return '';
  const url = new URL(`${String(apiBase).replace(/\/$/, '')}${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  return url.toString();
}

/**
 * The error a source route's refusal becomes.
 *
 * The Worker answers a failed upstream with a body -- `code` for a refusal or a
 * stall, `upstreamStatus` for the code the upstream itself returned -- and
 * `${path} returned 502` threw all of it away. A 400 we caused and an outage they
 * had reached the console as the same line; NCBI's 429 and the ledger's too. The
 * body travels on the error instead, where `reportDomainSourceFailures` already
 * looks for `code`, and the message carries it for anyone reading a log.
 *
 * It lives in this module, and not beside the `fetchJson` of
 * `domainSourceService.js` that first needed it, because the `/sources/*` routes
 * reach the browser through two independent entry points and the diagnostic is
 * worth nothing unless both build the same error: `fetchJson` covers the nine
 * paths of `DOMAIN_SOURCE_PATHS`, and `fetchWorkerSourceJson` below covers
 * `/sources/pubmed` and `/sources/s2`. PubMed is the route that motivated the
 * whole thing -- NCBI refusing us and our own quota ledger refusing us both
 * arrive as an HTTP 429, and `code` (`UPSTREAM_RATE_LIMITED` vs
 * `PROVIDER_RATE_LIMITED`) is the only way to tell them apart from a browser.
 * Of the two modules this is the one the other already imports, so a single
 * shared definition can only sit here without closing an import cycle.
 */
export function sourceResponseError(path, status, body = null) {
  const code = typeof body?.code === 'string' ? body.code : '';
  const upstreamStatus = Number.isInteger(body?.upstreamStatus) ? body.upstreamStatus : 0;
  const detail = [code, upstreamStatus ? `upstream ${upstreamStatus}` : ''].filter(Boolean).join(', ');
  const error = new Error(`${path} returned ${status}${detail ? ` (${detail})` : ''}`);
  error.status = status;
  if (code) error.code = code;
  if (upstreamStatus) error.upstreamStatus = upstreamStatus;
  return error;
}

// The unauthenticated half of this module, for the `/sources/*` routes the guest
// feed reads. `apiBase` and `fetchImpl` are injectable for the same reason
// `openAlexClient` injects them: `import.meta.env` does not exist under
// `node --test`, so without a seam these paths could only be tested in a browser.
export async function fetchWorkerSourceJson(path, params = {}, {
  timeoutMs,
  apiBase = configuredWorkerOrigin(),
  // Wrapped rather than passed by reference: a detached `fetch` is an illegal
  // invocation in a browser.
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const url = workerSourceUrl(path, params, apiBase);
  if (!url) throw new WorkerApiAuthError('WORKER_ORIGIN_NOT_ALLOWED');
  // One deadline for the headers and the body alike: these calls sit inside the
  // feed's `allSettled`, where an upstream that answers its headers and then
  // stops used to hold every other source behind it.
  const response = await fetchImpl(url, withRequestDeadline({ headers: { accept: 'application/json' } }, timeoutMs));
  if (!response.ok) {
    // Read under the same deadline as the headers (`withRequestDeadline` keeps
    // the signal armed for the body); a body that is not JSON is simply no body.
    const body = await response.json().catch(() => null);
    throw sourceResponseError(path, response.status, body);
  }
  return response.json();
}

export async function authenticatedWorkerFetch(input, options = {}) {
  const url = trustedWorkerUrl(input);
  if (!url) throw new WorkerApiAuthError('WORKER_ORIGIN_NOT_ALLOWED');
  const currentUser = auth.currentUser;
  if (!currentUser) throw new WorkerApiAuthError();
  const token = await currentUser.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  // Every caller but `publicListService` passed a signal of its own, and that one
  // could wait on a stalled Worker until the tab was closed. The default closes
  // that hole and the next one like it; a caller with its own budget — the AI
  // explanation spends seventy seconds legitimately — still overrides it.
  return fetch(url, withRequestDeadline({ ...options, headers }));
}
