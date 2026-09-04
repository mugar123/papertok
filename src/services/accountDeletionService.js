/**
 * Deletes the signed-in account through the Worker.
 *
 * The browser cannot walk this tree itself: public list documents and rate
 * limit ledgers refuse client deletes, and a crash after Auth is gone would
 * leave rows nobody can touch. The Worker owns the walk; this module only
 * confirms, retries 202s, and signs the tab out when the session is already
 * dead.
 */
import { IS_DEMO } from './firebase.js';
import { authenticatedWorkerFetch } from './workerApiClient.js';

export class AccountDeletionError extends Error {
  constructor(code = 'ACCOUNT_DELETION_FAILED', status = 502) {
    super(code);
    this.name = 'AccountDeletionError';
    this.code = code;
    this.status = status;
  }
}

const MAX_SLICES = 40;

function operations(overrides = {}) {
  return {
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    request: overrides.request || authenticatedWorkerFetch,
    apiBase: overrides.apiBase === undefined
      ? import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '')
      : overrides.apiBase,
    getToken: overrides.getToken,
  };
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function postSlice(api) {
  if (!api.apiBase) throw new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED', 503);
  let response;
  let payload;
  try {
    response = await api.request(`${api.apiBase}/account/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    payload = parsePayload(await response.text());
  } catch (error) {
    if (error?.code === 'WORKER_AUTH_REQUIRED' || error?.code === 'auth/user-token-expired') {
      throw new AccountDeletionError('AUTH_REQUIRED', 401);
    }
    throw new AccountDeletionError(error?.code || 'ACCOUNT_DELETION_UNREACHABLE', 0);
  }
  if (response.status === 401) {
    throw new AccountDeletionError(payload?.code || 'AUTH_REQUIRED', 401);
  }
  if (!response.ok && response.status !== 202) {
    throw new AccountDeletionError(payload?.code || 'ACCOUNT_DELETION_FAILED', response.status);
  }
  return payload;
}

/**
 * Repeats until the Worker reports `complete`, or until the session dies
 * after work has already started — which is what a lost response after Auth
 * deletion looks like from the tab.
 */
export async function deleteAccount(overrides) {
  const api = operations(overrides);
  if (api.isDemo) throw new AccountDeletionError('ACCOUNT_DELETION_UNSUPPORTED_IN_DEMO', 400);

  let started = false;
  for (let i = 0; i < MAX_SLICES; i += 1) {
    let payload;
    try {
      payload = await postSlice(api);
    } catch (error) {
      if (started && error?.code === 'AUTH_REQUIRED') {
        return { complete: true, stage: 'auth' };
      }
      throw error;
    }
    started = true;
    if (payload?.complete) return payload;
  }
  throw new AccountDeletionError('ACCOUNT_DELETION_INCOMPLETE', 504);
}
