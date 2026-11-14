/**
 * Sends a paper, and the reader's own highlights of it, to their Zotero library.
 *
 * Zotero hands out API keys through OAuth 1.0a. The exchange is split across
 * two signed-in requests so the account that started it is the one that
 * finishes it: `/zotero/connect` asks Zotero for a request token and keeps its
 * secret on the account, Zotero returns the browser to the frontend's
 * `/zotero/callback`, and `/zotero/complete` trades the verifier for the key
 * only when the token matches the one this account asked for. A callback
 * served by the Worker itself could not tell whose browser arrived, so an
 * authorize link started on one account could bind another person's library.
 *
 * The key is encrypted with `ZOTERO_TOKEN_KEY` and kept in
 * `users/{uid}/zotero/link`, which the Firestore rules close to every client.
 * Each sent paper keeps the keys and versions of its Zotero item and note in
 * `users/{uid}/zoteroItems/{paperId}`, so sending again updates them instead
 * of adding copies. A note changed in Zotero since it was sent is left alone
 * and a new one is added beside it.
 */

import type { WorkerEnv } from './env.ts';
import type { FirestoreWrite, QueryOptions } from './firestore-admin.ts';
import { readBoundedJson } from './bounded-body.ts';
import { verifyFirebaseIdentity } from './firebase-auth.ts';
import { isServiceAccountConfigured } from './firebase-service-account.ts';
import { createFirestoreAdmin, deleteWrite, encodeFields, mergeWrite } from './firestore-admin.ts';
import { encodeFirestoreDocId } from '../src/utils/firestore-doc-id.ts';

export const ZOTERO_PATHS = new Set(['/zotero/connect', '/zotero/complete', '/zotero/status', '/zotero/send', '/zotero/disconnect']);

const ZOTERO_OAUTH = 'https://www.zotero.org/oauth';
const ZOTERO_API = 'https://api.zotero.org';
// The personal library only. Notes access too: without it Zotero hides the note a send created, so the next send could not update it and would add another.
const KEY_PERMISSIONS = { name: 'PaperTok', library_access: '1', notes_access: '1', write_access: '1', all_groups: 'none' };
const PENDING_LIFETIME_MS = 15 * 60 * 1000;
const BODY_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const ROUTE_BUDGET_MS = 15_000;
const MAX_HIGHLIGHTS = 200;

export class ZoteroError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter?: string;
  constructor(code: string, status = 502, retryAfter?: string) {
    super(code);
    this.name = 'ZoteroError';
    this.code = code;
    this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

interface Admin {
  name(segments: string[]): string;
  getDocument<T extends object>(segments: string[]): Promise<T | null>;
  runQuery(options: QueryOptions): Promise<Array<{ data: Record<string, unknown> }>>;
  commit(writes: FirestoreWrite[]): Promise<unknown>;
}
interface ZoteroOptions { admin?: Admin; fetchImpl?: typeof fetch; now?: () => number; nonce?: () => string }
interface LinkDocument {
  pendingToken?: string; pendingSecret?: string; pendingAt?: number;
  key?: string; zoteroUserId?: string; username?: string; connectedAt?: string;
}
interface ItemRecord { zoteroUserId?: string; itemKey?: string; itemVersion?: number | null; itemType?: string; noteKey?: string | null; noteVersion?: number | null; sentAt?: string }
export interface ZoteroPaper {
  id: string; title: string; authors: string[]; date: string; doi: string; arxivId: string; pmid: string; pmcid: string;
  abstract: string; journal: string; url: string; preprint: boolean;
}
export interface ZoteroHighlight { quote: string; note: string; level: string }

// ---------------------------------------------------------------------------
// OAuth 1.0a (HMAC-SHA1), as Zotero's own example signs it.
// ---------------------------------------------------------------------------

export function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function toBase64(bytes: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(text: string) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export async function oauthHeader(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret = '') {
  const base = [method, percentEncode(url), percentEncode(Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&'))].join('&');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = toBase64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)));
  return `OAuth ${Object.entries({ ...params, oauth_signature: signature }).map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`).join(', ')}`;
}

// ---------------------------------------------------------------------------
// The stored key, sealed with AES-GCM.
// ---------------------------------------------------------------------------

async function sealingKey(env: WorkerEnv) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(env.ZOTERO_TOKEN_KEY)));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(env: WorkerEnv, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealingKey(env), new TextEncoder().encode(text));
  return `${toBase64(iv)}.${toBase64(sealed)}`;
}

export async function unseal(env: WorkerEnv, text: string) {
  const [iv, sealed] = text.split('.');
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await sealingKey(env), fromBase64(sealed));
  return new TextDecoder().decode(opened);
}

// ---------------------------------------------------------------------------
// Zotero requests.
// ---------------------------------------------------------------------------

function waitHeader(response: Response) {
  return response.headers.get('retry-after') || response.headers.get('backoff') || undefined;
}

async function zoteroFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, budget: AbortSignal) {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.any([budget, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  } catch {
    throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
  }
  if (response.status === 429 || response.status === 503) throw new ZoteroError('ZOTERO_RATE_LIMITED', 429, waitHeader(response) || '60');
  return response;
}

async function oauthStep(env: WorkerEnv, fetchImpl: typeof fetch, budget: AbortSignal, step: 'request' | 'access', extra: Record<string, string>, tokenSecret = '', options: ZoteroOptions = {}) {
  const url = `${ZOTERO_OAUTH}/${step}`;
  const params = {
    oauth_consumer_key: String(env.ZOTERO_CLIENT_KEY),
    oauth_nonce: options.nonce?.() ?? crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor((options.now?.() ?? Date.now()) / 1000)),
    oauth_version: '1.0',
    ...extra,
  };
  const response = await zoteroFetch(fetchImpl, url, {
    method: 'POST',
    headers: { authorization: await oauthHeader('POST', url, params, String(env.ZOTERO_CLIENT_SECRET), tokenSecret) },
  }, budget);
  const text = await response.text();
  if (response.status === 401 || response.status === 400) {
    throw step === 'access' ? new ZoteroError('ZOTERO_AUTHORIZATION_REFUSED', 400) : new ZoteroError('ZOTERO_NOT_CONFIGURED', 503);
  }
  if (!response.ok) throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
  return new URLSearchParams(text);
}

async function apiRequest(key: string, fetchImpl: typeof fetch, budget: AbortSignal, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await zoteroFetch(fetchImpl, `${ZOTERO_API}${path}`, {
    method,
    headers: {
      'zotero-api-key': key,
      'zotero-api-version': '3',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, budget);
  // Zotero answers 403 for a revoked key as for one that lacks the right.
  if (response.status === 403) throw new ZoteroError('ZOTERO_NOT_CONNECTED', 409);
  return response;
}

function writeToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

async function createObject(key: string, userId: string, fetchImpl: typeof fetch, budget: AbortSignal, object: Record<string, unknown>) {
  const response = await apiRequest(key, fetchImpl, budget, 'POST', `/users/${userId}/items`, [object], { 'zotero-write-token': writeToken() });
  const payload = await response.json().catch(() => null) as { successful?: Record<string, { key?: string; version?: number }> } | null;
  const saved = payload?.successful?.['0'];
  if (!response.ok || typeof saved?.key !== 'string') throw new ZoteroError('ZOTERO_WRITE_FAILED', 502);
  return { key: saved.key, version: Number(saved.version) || 0 };
}

/** The new version, or null when the object is gone or changed in Zotero since `version`. */
async function patchObject(key: string, userId: string, fetchImpl: typeof fetch, budget: AbortSignal, objectKey: string, version: number, fields: Record<string, unknown>) {
  const response = await apiRequest(key, fetchImpl, budget, 'PATCH', `/users/${userId}/items/${encodeURIComponent(objectKey)}`, fields, {
    'if-unmodified-since-version': String(version),
  });
  if (response.status === 404 || response.status === 412) return null;
  if (!response.ok) throw new ZoteroError('ZOTERO_WRITE_FAILED', 502);
  return Number(response.headers.get('last-modified-version')) || version;
}

// ---------------------------------------------------------------------------
// What is sent.
// ---------------------------------------------------------------------------

function cleanText(value: unknown, cap: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, cap) : '';
}

/** The citation the browser sends, bounded, or null when it names no paper. */
export function normalizeZoteroPaper(input: unknown): ZoteroPaper | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const id = cleanText(value.id, 300);
  const title = cleanText(value.title, 1000);
  if (!id || !title) return null;
  const url = cleanText(value.url, 2000);
  return {
    id,
    title,
    authors: (Array.isArray(value.authors) ? value.authors : []).map(name => cleanText(name, 300)).filter(Boolean).slice(0, 200),
    date: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(cleanText(value.date, 10)) ? cleanText(value.date, 10) : '',
    doi: cleanText(value.doi, 300),
    arxivId: cleanText(value.arxivId, 100),
    pmid: /^\d{1,12}$/.test(cleanText(value.pmid, 12)) ? cleanText(value.pmid, 12) : '',
    pmcid: cleanText(value.pmcid, 20),
    abstract: typeof value.abstract === 'string' ? value.abstract.trim().slice(0, 20_000) : '',
    journal: cleanText(value.journal, 500),
    url: /^https?:\/\//i.test(url) ? url : '',
    preprint: value.preprint === true,
  };
}

/**
 * The Zotero item. A preprint is never filed as a journal article, since a
 * repository copy proves no review, and a paper with no known journal is a
 * plain document rather than an article in a venue nobody named.
 */
export function zoteroItem(paper: ZoteroPaper) {
  const common = {
    title: paper.title,
    creators: paper.authors.map(name => ({ creatorType: 'author', name })),
    abstractNote: paper.abstract,
    date: paper.date,
    DOI: paper.doi,
    url: paper.url || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : ''),
    libraryCatalog: 'PaperTok',
  };
  return paper.preprint
    ? { itemType: 'preprint', ...common, repository: paper.arxivId ? 'arXiv' : '', archiveID: paper.arxivId ? `arXiv:${paper.arxivId}` : '' }
    : paper.journal
      ? { itemType: 'journalArticle', ...common, publicationTitle: paper.journal, PMID: paper.pmid, PMCID: paper.pmcid }
      : { itemType: 'document', ...common };
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const LEVEL_LABELS: Record<string, string> = { beginner: 'Beginner', university: 'University', researcher: 'Researcher' };

/**
 * The quotes come from PaperTok's plain-words versions, not from the paper,
 * and the note says so before any of them.
 */
export function highlightsNote(title: string, highlights: ZoteroHighlight[]) {
  const levels = [...new Set(highlights.map(h => LEVEL_LABELS[h.level] || h.level))].join(', ');
  return [
    `<h1>PaperTok highlights: ${escapeHtml(title)}</h1>`,
    `<p><em>Quoted from PaperTok's plain-words version (${escapeHtml(levels)}), not from the original text.</em></p>`,
    ...highlights.map(h => `<blockquote><p>${escapeHtml(h.quote)}</p></blockquote>${h.note ? `<p>${escapeHtml(h.note)}</p>` : ''}`),
  ].join('\n');
}

async function readHighlights(admin: Admin, uid: string, paperId: string): Promise<ZoteroHighlight[]> {
  const rows = await admin.runQuery({
    parentSegments: ['users', uid],
    collectionId: 'highlights',
    where: { field: 'paperId', op: 'EQUAL', value: paperId },
    limit: MAX_HIGHLIGHTS,
  });
  return rows
    .map(row => row.data)
    .filter(data => data.kind !== 'ai' && typeof data.quote === 'string' && data.quote.trim())
    .sort((a, b) => String(a.sectionId).localeCompare(String(b.sectionId)) || Number(a.paragraphIndex) - Number(b.paragraphIndex))
    .map(data => ({
      quote: [data.quote, data.endQuote].filter(part => typeof part === 'string' && part.trim()).join(' … '),
      note: typeof data.note === 'string' ? data.note.trim() : '',
      level: typeof data.level === 'string' ? data.level : '',
    }));
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

async function readBody(request: Request) {
  const body = await readBoundedJson<Record<string, unknown>>(request, BODY_LIMIT_BYTES, {
    tooLarge: () => new ZoteroError('BODY_TOO_LARGE', 413),
    invalid: () => new ZoteroError('INVALID_BODY', 400),
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ZoteroError('INVALID_BODY', 400);
  return body;
}

function linkSegments(uid: string) {
  return ['users', uid, 'zotero', 'link'];
}

async function connectedKey(admin: Admin, env: WorkerEnv, uid: string) {
  const link = await admin.getDocument<LinkDocument>(linkSegments(uid));
  if (!link?.key || !link.zoteroUserId) throw new ZoteroError('ZOTERO_NOT_CONNECTED', 409);
  try {
    return { key: await unseal(env, link.key), userId: link.zoteroUserId };
  } catch {
    // Sealed under a ZOTERO_TOKEN_KEY that has since changed: the key is unusable, so the account reconnects.
    await admin.commit([deleteWrite(admin.name(linkSegments(uid)))]);
    throw new ZoteroError('ZOTERO_NOT_CONNECTED', 409);
  }
}

export function isZoteroConfigured(env: WorkerEnv) {
  return Boolean(env.ZOTERO_CLIENT_KEY && env.ZOTERO_CLIENT_SECRET && env.ZOTERO_TOKEN_KEY && isServiceAccountConfigured(env));
}

export async function handleZoteroRequest(request: Request, env: WorkerEnv, origin: string, options: ZoteroOptions = {}) {
  const pathname = new URL(request.url).pathname;
  const method = pathname === '/zotero/status' ? 'GET' : 'POST';
  if (request.method !== method) throw new ZoteroError('METHOD_NOT_ALLOWED', 405);
  if (!isZoteroConfigured(env)) throw new ZoteroError('ZOTERO_NOT_CONFIGURED', 503);
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: method === 'GET' });
  const admin: Admin = options.admin || createFirestoreAdmin(env);
  const fetchImpl = options.fetchImpl || fetch;
  const budget = AbortSignal.timeout(ROUTE_BUDGET_MS);
  const now = options.now?.() ?? Date.now();
  const link = admin.name(linkSegments(identity.uid));

  if (pathname === '/zotero/status') {
    const paperId = cleanText(new URL(request.url).searchParams.get('paperId'), 300);
    const [current, sent] = await Promise.all([
      admin.getDocument<LinkDocument>(linkSegments(identity.uid)),
      paperId ? admin.getDocument<ItemRecord>(['users', identity.uid, 'zoteroItems', encodeFirestoreDocId(paperId)]) : null,
    ]);
    const connected = Boolean(current?.key);
    return {
      connected,
      username: connected ? current?.username || null : null,
      sentAt: connected && sent?.zoteroUserId === current?.zoteroUserId ? sent?.sentAt || null : null,
    };
  }

  if (pathname === '/zotero/connect') {
    const answer = await oauthStep(env, fetchImpl, budget, 'request', { oauth_callback: `${origin}/zotero/callback` }, '', options);
    const token = answer.get('oauth_token');
    const secret = answer.get('oauth_token_secret');
    if (!token || !secret) throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
    await admin.commit([mergeWrite(link, { pendingToken: token, pendingSecret: await seal(env, secret), pendingAt: now }, { mustExist: false })]);
    return { authorizeUrl: `${ZOTERO_OAUTH}/authorize?${new URLSearchParams({ oauth_token: token, ...KEY_PERMISSIONS })}` };
  }

  if (pathname === '/zotero/complete') {
    const body = await readBody(request);
    const token = cleanText(body.oauthToken, 200);
    const verifier = cleanText(body.oauthVerifier, 200);
    const pending = await admin.getDocument<LinkDocument>(linkSegments(identity.uid));
    if (!token || !verifier || !pending?.pendingToken || !pending.pendingSecret || pending.pendingToken !== token
      || now - Number(pending.pendingAt) > PENDING_LIFETIME_MS) {
      throw new ZoteroError('ZOTERO_CONNECTION_EXPIRED', 400);
    }
    const answer = await oauthStep(env, fetchImpl, budget, 'access', { oauth_token: token, oauth_verifier: verifier }, await unseal(env, pending.pendingSecret), options);
    const key = answer.get('oauth_token_secret');
    const zoteroUserId = answer.get('userID');
    if (!key || !zoteroUserId || !/^\d+$/.test(zoteroUserId)) throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
    const username = answer.get('username') || null;
    // A whole-document write, so the pending token goes with it.
    await admin.commit([{ update: { name: link, fields: encodeFields({
      key: await seal(env, key), zoteroUserId, username, connectedAt: new Date(now).toISOString(),
    }) } }]);
    if (pending.key) await revokeKey(env, pending.key, fetchImpl, budget);
    return { connected: true, username };
  }

  if (pathname === '/zotero/disconnect') {
    const current = await admin.getDocument<LinkDocument>(linkSegments(identity.uid));
    await admin.commit([deleteWrite(link)]);
    if (current?.key) await revokeKey(env, current.key, fetchImpl, budget);
    return { connected: false };
  }

  // /zotero/send
  const body = await readBody(request);
  const paper = normalizeZoteroPaper(body.paper);
  if (!paper) throw new ZoteroError('INVALID_PAPER', 400);
  const { key, userId } = await connectedKey(admin, env, identity.uid);
  const recordSegments = ['users', identity.uid, 'zoteroItems', encodeFirestoreDocId(paper.id)];
  const [stored, highlights] = await Promise.all([
    admin.getDocument<ItemRecord>(recordSegments),
    readHighlights(admin, identity.uid, paper.id),
  ]);
  const record: ItemRecord = stored?.zoteroUserId === userId ? { ...stored } : { zoteroUserId: userId };
  // Saved after each object Zotero creates, so a send that fails halfway is resumed, not repeated.
  const save = (fields: ItemRecord) => {
    Object.assign(record, fields);
    return admin.commit([mergeWrite(admin.name(recordSegments), { ...record, zoteroUserId: userId }, { mustExist: false })]);
  };
  try {
    const item = zoteroItem(paper);
    // An item edited in Zotero, or filed there under another type, keeps the reader's version; only a deleted one is sent again.
    const patched = record.itemKey && typeof record.itemVersion === 'number' && record.itemType === item.itemType
      ? await patchObject(key, userId, fetchImpl, budget, record.itemKey, record.itemVersion, item)
      : null;
    if (patched !== null) record.itemVersion = patched;
    else if (record.itemKey && await itemExists(key, userId, fetchImpl, budget, record.itemKey)) record.itemVersion = null;
    else {
      const created = await createObject(key, userId, fetchImpl, budget, { ...item, tags: [], collections: [], relations: {} });
      await save({ itemKey: created.key, itemVersion: created.version, itemType: item.itemType, noteKey: null, noteVersion: null });
    }

    if (highlights.length) {
      const note = highlightsNote(paper.title, highlights);
      const updated = record.noteKey && typeof record.noteVersion === 'number'
        ? await patchObject(key, userId, fetchImpl, budget, record.noteKey, record.noteVersion, { note })
        : null;
      if (updated !== null) record.noteVersion = updated;
      else {
        const created = await createObject(key, userId, fetchImpl, budget, { itemType: 'note', note, parentItem: record.itemKey, tags: [], collections: [], relations: {} });
        Object.assign(record, { noteKey: created.key, noteVersion: created.version });
      }
    }

    const sentAt = new Date(now).toISOString();
    await save({ sentAt });
    return { sentAt, highlights: highlights.length };
  } catch (error) {
    if (error instanceof ZoteroError && error.code === 'ZOTERO_NOT_CONNECTED') await admin.commit([deleteWrite(link)]).catch(() => {});
    throw error;
  }
}

/** Best effort: the key is already forgotten here whether or not Zotero hears of it. */
async function revokeKey(env: WorkerEnv, sealed: string, fetchImpl: typeof fetch, budget: AbortSignal) {
  await unseal(env, sealed)
    .then(key => apiRequest(key, fetchImpl, budget, 'DELETE', `/keys/${encodeURIComponent(key)}`))
    .catch(() => {});
}

async function itemExists(key: string, userId: string, fetchImpl: typeof fetch, budget: AbortSignal, itemKey: string) {
  const response = await apiRequest(key, fetchImpl, budget, 'GET', `/users/${userId}/items/${encodeURIComponent(itemKey)}?format=keys`);
  return response.ok;
}
