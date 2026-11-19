import { isOrcidHost, isValidOrcidId } from '../utils/orcid-id.ts';
import { authenticatedWorkerFetch, workerSourceUrl } from './worker-api-client.ts';

/** The ORCID iD an ORCID sign-in proved for this account (worker/orcid.ts). */
export type OrcidConnection = NonNullable<ReturnType<typeof normalizeOrcidConnection>>;

export class OrcidRequestError extends Error {
  declare code: string;
  constructor(code: string) {
    super(code);
    this.name = 'OrcidRequestError';
    this.code = code;
  }
}

// Remove the one-time code and its state before routing or analytics can read the URL.
export const orcidCallbackParams = (() => {
  if (!/^\/orcid\/callback\/?$/.test(globalThis.location?.pathname ?? '')) return null;
  const params = new URLSearchParams(globalThis.location.search);
  globalThis.history.replaceState(globalThis.history.state, '', '/orcid/callback');
  return { code: params.get('code') || '', state: params.get('state') || '' };
})();

/** The `orcid` field of the user document, or null when it is missing or not one the Worker wrote. */
export function normalizeOrcidConnection(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const { id, name, host, connectedAt } = value as Record<string, unknown>;
  if (!isValidOrcidId(id) || !isOrcidHost(host)) return null;
  return {
    id,
    host,
    // A record can keep its name private; then it is unknown, not empty.
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    connectedAt: typeof connectedAt === 'string' ? connectedAt : null,
  };
}

/** The iD as ORCID asks applications to show it: the full https address of the record. */
export function orcidRecordUrl({ id, host }: Pick<OrcidConnection, 'id' | 'host'>) {
  return `https://${host}/${id}`;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const url = workerSourceUrl(path);
  if (!url) throw new OrcidRequestError('ORCID_NOT_CONFIGURED');
  let response: Response;
  try {
    response = await authenticatedWorkerFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 20_000);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    throw new OrcidRequestError(code === 'WORKER_AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'ORCID_UNREACHABLE');
  }
  const payload = await response.json().catch(() => ({})) as T & { code?: string };
  if (!response.ok) throw new OrcidRequestError(payload.code || 'ORCID_FAILED');
  return payload;
}

/** Leaves for ORCID's sign-in page; ORCID returns to `/orcid/callback`. */
export async function connectOrcid() {
  const { authorizeUrl } = await post<{ authorizeUrl: string }>('/orcid/connect');
  if (!/^https:\/\/(?:sandbox\.)?orcid\.org\/oauth\/authorize\?/.test(String(authorizeUrl))) throw new OrcidRequestError('ORCID_FAILED');
  location.assign(authorizeUrl);
}

export async function completeOrcid(code: string, state: string) {
  const { orcid } = await post<{ orcid: unknown }>('/orcid/complete', { code, state });
  const connection = normalizeOrcidConnection(orcid);
  if (!connection) throw new OrcidRequestError('ORCID_FAILED');
  return connection;
}

export async function disconnectOrcid() {
  await post<{ orcid: null }>('/orcid/disconnect');
}
