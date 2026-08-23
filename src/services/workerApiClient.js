import { auth } from './firebase.js';
import { withRequestDeadline } from '../utils/requestDeadline.js';

const PRODUCTION_WORKER_ORIGIN = 'https://papertok-report-api.papertok-mugar123.workers.dev';

function configuredWorkerOrigin() {
  const configured = import.meta.env?.VITE_PAPER_API_BASE_URL;
  if (!configured) return '';
  try {
    const url = new URL(configured);
    const isLocalDevelopment = import.meta.env?.DEV
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && ['http:', 'https:'].includes(url.protocol);
    return url.origin === PRODUCTION_WORKER_ORIGIN || isLocalDevelopment ? url.origin : '';
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
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
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
