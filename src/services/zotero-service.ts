import type { Paper } from '../models/paper.ts';
import { authenticatedWorkerFetch, workerSourceUrl } from './worker-api-client.ts';

export type ZoteroCitation = ReturnType<typeof zoteroCitation>;
export interface ZoteroStatus { connected: boolean; username: string | null; sentAt: string | null }

const PENDING_KEY = 'papertok_zotero_pending';
const PENDING_LIFETIME_MS = 15 * 60 * 1000;
interface PendingSend { uid: string; citation: ZoteroCitation; returnTo: string; createdAt: number }

export class ZoteroRequestError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter: number | null;
  constructor(code: string, status: number, retryAfter: number | null = null) {
    super(code);
    this.name = 'ZoteroRequestError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Remove the one-time verifier before routing or analytics can read the URL.
export const zoteroCallbackParams = (() => {
  if (!/^\/zotero\/callback\/?$/.test(globalThis.location?.pathname ?? '')) return null;
  const params = new URLSearchParams(globalThis.location.search);
  globalThis.history.replaceState(globalThis.history.state, '', '/zotero/callback');
  return { oauthToken: params.get('oauth_token') || '', oauthVerifier: params.get('oauth_verifier') || '' };
})();

function authorName(author: Paper['authors'][number]) {
  return typeof author === 'string' ? author.trim() : author?.name?.trim() || '';
}

/** What the Worker needs to file the paper. The abstract is the source's own, never a generated summary. */
export function zoteroCitation(paper: Paper) {
  const date = [paper.publishedDate, paper.publicationDate, paper.published]
    .find(value => typeof value === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?/.test(value))?.slice(0, 10)
    || (paper.year ? String(paper.year) : '');
  return {
    id: paper.id,
    title: paper.title,
    authors: (paper.authors || []).map(authorName).filter(Boolean),
    date,
    doi: paper.doi || '',
    arxivId: paper.arxivId || '',
    pmid: paper.pmid || '',
    pmcid: paper.pmcid || '',
    abstract: paper.abstract || '',
    journal: paper.journal || '',
    url: paper.landingPageUrl || '',
    preprint: paper.publicationStatus === 'preprint' || Boolean(paper.arxivId && !paper.journal),
  };
}

async function request<T>(path: string, init: RequestInit = {}, params: Record<string, unknown> = {}): Promise<T> {
  const url = workerSourceUrl(path, params);
  if (!url) throw new ZoteroRequestError('ZOTERO_NOT_CONFIGURED', 503);
  let response: Response;
  try {
    response = await authenticatedWorkerFetch(url, init, 20_000);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    throw new ZoteroRequestError(code === 'WORKER_AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'ZOTERO_UNAVAILABLE', 0);
  }
  const payload = await response.json().catch(() => ({})) as T & { code?: string };
  if (!response.ok) {
    const wait = Number(response.headers.get('retry-after'));
    throw new ZoteroRequestError(payload.code || 'ZOTERO_FAILED', response.status, Number.isFinite(wait) && wait > 0 ? wait : null);
  }
  return payload;
}

function post<T>(path: string, body: unknown = {}) {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export function zoteroStatus(paperId?: string) {
  return request<ZoteroStatus>('/zotero/status', {}, { paperId });
}

export function sendToZotero(citation: ZoteroCitation) {
  return post<{ sentAt: string; highlights: number }>('/zotero/send', { paper: citation });
}

export function disconnectZotero() {
  return post<{ connected: false }>('/zotero/disconnect');
}

/** Leaves for Zotero's authorization page; the send waits in this tab until the callback. */
export async function connectZotero(uid: string, citation: ZoteroCitation | null) {
  const { authorizeUrl } = await post<{ authorizeUrl: string }>('/zotero/connect');
  if (!/^https:\/\/www\.zotero\.org\/oauth\/authorize\?/.test(authorizeUrl)) throw new ZoteroRequestError('ZOTERO_FAILED', 502);
  const pending: PendingSend | null = citation
    ? { uid, citation, returnTo: `${location.pathname}${location.search}`, createdAt: Date.now() }
    : null;
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Without storage the account still connects; only the queued send is lost.
  }
  location.assign(authorizeUrl);
}

/** The send queued by `connectZotero` for this account, once, or null. */
export function takePendingZoteroSend(uid: string) {
  let pending: PendingSend | null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!pending || pending.uid !== uid || !pending.citation?.id || !(Date.now() - pending.createdAt < PENDING_LIFETIME_MS)) return null;
  return { citation: pending.citation, returnTo: pending.returnTo.startsWith('/') && !pending.returnTo.startsWith('//') ? pending.returnTo : '/' };
}

export function completeZotero(oauthToken: string, oauthVerifier: string) {
  return post<{ connected: true; username: string | null }>('/zotero/complete', { oauthToken, oauthVerifier });
}
