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
