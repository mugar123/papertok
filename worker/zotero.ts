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
import { escapeHtml } from './share-pages.ts';

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
interface ZoteroOptions { admin?: Admin }
interface LinkDocument {
  pendingToken?: string; pendingSecret?: string; pendingAt?: number;
  key?: string; zoteroUserId?: string; username?: string; connectedAt?: string;
}
interface ItemRecord { zoteroUserId?: string; itemKey?: string; itemVersion?: number | null; itemType?: string; noteKey?: string | null; noteVersion?: number | null; sentAt?: string }
interface ZoteroPaper {
  id: string; title: string; authors: string[]; date: string; doi: string; arxivId: string; pmid: string; pmcid: string;
  abstract: string; journal: string; url: string; preprint: boolean;
}
interface ZoteroHighlight { quote: string; note: string; level: string }

// ---------------------------------------------------------------------------
// OAuth 1.0a (HMAC-SHA1), as Zotero's own example signs it.
// ---------------------------------------------------------------------------

function percentEncode(value: string) {
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

async function seal(env: WorkerEnv, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealingKey(env), new TextEncoder().encode(text));
  return `${toBase64(iv)}.${toBase64(sealed)}`;
}

async function unseal(env: WorkerEnv, text: string) {
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

async function zoteroFetch(url: string, init: RequestInit, budget: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.any([budget, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  } catch {
    throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
  }
  if (response.status === 429 || response.status === 503) throw new ZoteroError('ZOTERO_RATE_LIMITED', 429, waitHeader(response) || '60');
  return response;
}

async function oauthStep(env: WorkerEnv, budget: AbortSignal, step: 'request' | 'access', extra: Record<string, string>, tokenSecret = '') {
  const url = `${ZOTERO_OAUTH}/${step}`;
  const params = {
    oauth_consumer_key: String(env.ZOTERO_CLIENT_KEY),
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...extra,
  };
  const response = await zoteroFetch(url, {
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

interface Zotero { key: string; userId: string; budget: AbortSignal }

async function apiRequest(z: Pick<Zotero, 'key' | 'budget'>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await zoteroFetch(`${ZOTERO_API}${path}`, {
    method,
    headers: {
      'zotero-api-key': z.key,
      'zotero-api-version': '3',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, z.budget);
  // Zotero answers 403 for a revoked key as for one that lacks the right.
  if (response.status === 403) throw new ZoteroError('ZOTERO_NOT_CONNECTED', 409);
  return response;
}

function writeToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

const OBJECT_KEY_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

/** A key in Zotero's own format, chosen here so a create whose answer is lost can be looked up instead of repeated. */
function newObjectKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => OBJECT_KEY_ALPHABET[b % OBJECT_KEY_ALPHABET.length]).join('');
}

async function createObject(z: Zotero, object: Record<string, unknown>) {
  const response = await apiRequest(z, 'POST', `/users/${z.userId}/items`, [object], { 'zotero-write-token': writeToken() });
  const payload = await response.json().catch(() => null) as { successful?: Record<string, { key?: string; version?: number }> } | null;
  const saved = payload?.successful?.['0'];
  if (!response.ok || !saved || saved.key !== object.key) throw new ZoteroError('ZOTERO_WRITE_FAILED', 502);
  return Number(saved.version) || 0;
}

/** The new version, 'missing' when the object is gone, or 'changed' when it was edited in Zotero since `version`. */
async function patchObject(z: Zotero, objectKey: string, version: number, fields: Record<string, unknown>) {
  const response = await apiRequest(z, 'PATCH', `/users/${z.userId}/items/${encodeURIComponent(objectKey)}`, fields, {
    'if-unmodified-since-version': String(version),
  });
  if (response.status === 404) return 'missing' as const;
  if (response.status === 412) return 'changed' as const;
  if (!response.ok) throw new ZoteroError('ZOTERO_WRITE_FAILED', 502);
  return Number(response.headers.get('last-modified-version')) || version;
}

/** The object's version, or null only when Zotero answers that it does not have it. */
async function versionOf(z: Zotero, objectKey: string) {
  const response = await apiRequest(z, 'GET', `/users/${z.userId}/items?format=versions&itemKey=${encodeURIComponent(objectKey)}`);
  if (!response.ok) throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
  const versions = await response.json().catch(() => null) as Record<string, number> | null;
  if (!versions || typeof versions !== 'object') throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
  return typeof versions[objectKey] === 'number' ? versions[objectKey] : null;
}

// ---------------------------------------------------------------------------
// What is sent.
// ---------------------------------------------------------------------------

/** Text on one line, whitespace collapsed, at most `cap` characters. */
function singleLine(value: unknown, cap: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, cap) : '';
}

/** The citation the browser sends, bounded, or null when it names no paper. */
export function normalizeZoteroPaper(input: unknown): ZoteroPaper | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const id = singleLine(value.id, 300);
  const title = singleLine(value.title, 1000);
  if (!id || !title) return null;
  const url = singleLine(value.url, 2000);
  return {
    id,
    title,
    authors: (Array.isArray(value.authors) ? value.authors : []).map(name => singleLine(name, 300)).filter(Boolean).slice(0, 200),
    date: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(singleLine(value.date, 10)) ? singleLine(value.date, 10) : '',
    doi: singleLine(value.doi, 300),
    arxivId: singleLine(value.arxivId, 100),
    pmid: /^\d{1,12}$/.test(singleLine(value.pmid, 12)) ? singleLine(value.pmid, 12) : '',
    pmcid: singleLine(value.pmcid, 20),
    abstract: typeof value.abstract === 'string' ? value.abstract.trim().slice(0, 20_000) : '',
    journal: singleLine(value.journal, 500),
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
  // Zotero reads an `arXiv:` line in Extra as the paper's arXiv id on types without an archive field.
  const arxivExtra = paper.arxivId ? `arXiv: ${paper.arxivId}` : '';
  return paper.preprint
    ? { itemType: 'preprint', ...common, repository: paper.arxivId ? 'arXiv' : '', archiveID: paper.arxivId ? `arXiv:${paper.arxivId}` : '' }
    : paper.journal
      ? { itemType: 'journalArticle', ...common, publicationTitle: paper.journal, PMID: paper.pmid, PMCID: paper.pmcid, extra: arxivExtra }
      : { itemType: 'document', ...common, extra: arxivExtra };
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

function isZoteroConfigured(env: WorkerEnv) {
  return Boolean(env.ZOTERO_CLIENT_KEY && env.ZOTERO_CLIENT_SECRET && env.ZOTERO_TOKEN_KEY && isServiceAccountConfigured(env));
}

export async function handleZoteroRequest(request: Request, env: WorkerEnv, origin: string, options: ZoteroOptions = {}) {
  const pathname = new URL(request.url).pathname;
  const method = pathname === '/zotero/status' ? 'GET' : 'POST';
  if (request.method !== method) throw new ZoteroError('METHOD_NOT_ALLOWED', 405);
  if (!isZoteroConfigured(env)) throw new ZoteroError('ZOTERO_NOT_CONFIGURED', 503);
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: method === 'GET' });
  const admin: Admin = options.admin || createFirestoreAdmin(env);
  const budget = AbortSignal.timeout(ROUTE_BUDGET_MS);
  const now = Date.now();
  const link = admin.name(linkSegments(identity.uid));

  if (pathname === '/zotero/status') {
    const paperId = singleLine(new URL(request.url).searchParams.get('paperId'), 300);
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
    const answer = await oauthStep(env, budget, 'request', { oauth_callback: `${origin}/zotero/callback` });
    const token = answer.get('oauth_token');
    const secret = answer.get('oauth_token_secret');
    if (!token || !secret) throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
    await admin.commit([mergeWrite(link, { pendingToken: token, pendingSecret: await seal(env, secret), pendingAt: now }, { mustExist: false })]);
    return { authorizeUrl: `${ZOTERO_OAUTH}/authorize?${new URLSearchParams({ oauth_token: token, ...KEY_PERMISSIONS })}` };
  }

  if (pathname === '/zotero/complete') {
    const body = await readBody(request);
    const token = singleLine(body.oauthToken, 200);
    const verifier = singleLine(body.oauthVerifier, 200);
    const pending = await admin.getDocument<LinkDocument>(linkSegments(identity.uid));
    if (!token || !verifier || !pending?.pendingToken || !pending.pendingSecret || pending.pendingToken !== token
      || now - Number(pending.pendingAt) > PENDING_LIFETIME_MS) {
      throw new ZoteroError('ZOTERO_CONNECTION_EXPIRED', 400);
    }
    const answer = await oauthStep(env, budget, 'access', { oauth_token: token, oauth_verifier: verifier }, await unseal(env, pending.pendingSecret));
    const key = answer.get('oauth_token_secret');
    const zoteroUserId = answer.get('userID');
    if (!key || !zoteroUserId || !/^\d+$/.test(zoteroUserId)) throw new ZoteroError('ZOTERO_UNAVAILABLE', 502);
    const username = answer.get('username') || null;
    // A whole-document write, so the pending token goes with it.
    await admin.commit([{ update: { name: link, fields: encodeFields({
      key: await seal(env, key), zoteroUserId, username, connectedAt: new Date(now).toISOString(),
    }) } }]);
    if (pending.key) await revokeKey(env, pending.key, budget);
    return { connected: true, username };
  }

  if (pathname === '/zotero/disconnect') {
    const current = await admin.getDocument<LinkDocument>(linkSegments(identity.uid));
    await admin.commit([deleteWrite(link)]);
    if (current?.key) await revokeKey(env, current.key, budget);
    return { connected: false };
  }

  const body = await readBody(request);
  const paper = normalizeZoteroPaper(body.paper);
  if (!paper) throw new ZoteroError('INVALID_PAPER', 400);
  const { key, userId } = await connectedKey(admin, env, identity.uid);
  try {
    return await sendPaper(admin, identity.uid, { key, userId, budget }, paper, now);
  } catch (error) {
    if (error instanceof ZoteroError && error.code === 'ZOTERO_NOT_CONNECTED') await admin.commit([deleteWrite(link)]).catch(() => {});
    throw error;
  }
}

/**
 * Brings the paper's Zotero item and note up to date. Each object's key is
 * chosen and recorded before Zotero is asked to create it, with version 0
 * until Zotero confirms it, so a create whose answer was lost is looked up
 * on the next send instead of made twice.
 */
async function sendPaper(admin: Admin, uid: string, z: Zotero, paper: ZoteroPaper, now: number) {
  const recordSegments = ['users', uid, 'zoteroItems', encodeFirestoreDocId(paper.id)];
  const [stored, highlights] = await Promise.all([
    admin.getDocument<ItemRecord>(recordSegments),
    readHighlights(admin, uid, paper.id),
  ]);
  const record: ItemRecord = stored?.zoteroUserId === z.userId ? { ...stored } : { zoteroUserId: z.userId };
  const save = (fields: ItemRecord) => {
    Object.assign(record, fields);
    return admin.commit([mergeWrite(admin.name(recordSegments), { ...record, zoteroUserId: z.userId }, { mustExist: false })]);
  };

  const item = zoteroItem(paper);
  // An item filed in Zotero under another type keeps it; PaperTok does not change a type under the reader.
  const itemState = record.itemKey && record.itemType !== item.itemType
    ? ((await versionOf(z, record.itemKey)) === null ? 'missing' : 'kept')
    : await updateItem(z, record.itemKey, record.itemVersion, item);
  if (itemState === 'missing') {
    // A new item gets a new note: the old note, if any, hangs under the item that is gone.
    const itemKey = record.itemKey && record.itemVersion === 0 ? record.itemKey : newObjectKey();
    await save({ itemKey, itemVersion: 0, itemType: item.itemType, noteKey: null, noteVersion: null });
    await save({ itemVersion: await createObject(z, { ...item, key: itemKey, tags: [], collections: [], relations: {} }) });
  } else if (itemState !== 'kept') {
    record.itemVersion = itemState;
  }

  if (highlights.length) {
    const note = { note: highlightsNote(paper.title, highlights) };
    const noteState = await settle(z, record.noteKey ?? undefined, record.noteVersion, note);
    if (typeof noteState === 'number') {
      record.noteVersion = noteState;
    } else {
      // Missing, or edited in Zotero since: a new note goes beside it rather than over it.
      const noteKey = record.noteKey && record.noteVersion === 0 && noteState === 'missing' ? record.noteKey : newObjectKey();
      await save({ noteKey, noteVersion: 0 });
      await save({ noteVersion: await createObject(z, { itemType: 'note', ...note, key: noteKey, parentItem: record.itemKey, tags: [], collections: [], relations: {} }) });
    }
  } else if (record.noteKey) {
    // Every highlight was removed: the note PaperTok wrote goes too, unless the reader edited it in Zotero.
    const noteVersion = record.noteVersion === 0 ? await versionOf(z, record.noteKey) : record.noteVersion;
    if (typeof noteVersion === 'number') {
      const response = await apiRequest(z, 'DELETE', `/users/${z.userId}/items/${encodeURIComponent(record.noteKey)}`, undefined, {
        'if-unmodified-since-version': String(noteVersion),
      });
      if (!response.ok && response.status !== 404 && response.status !== 412) throw new ZoteroError('ZOTERO_WRITE_FAILED', 502);
    }
    Object.assign(record, { noteKey: null, noteVersion: null });
  }

  const sentAt = new Date(now).toISOString();
  await save({ sentAt });
  return { sentAt, highlights: highlights.length };
}

/**
 * Where one object PaperTok wrote stands, updated to `fields` when it is
 * still as PaperTok left it: its new version, 'changed' when it was edited
 * in Zotero since, or 'missing' when it has to be created. A stored version
 * of 0 marks a create whose answer never came back; null, an object edited
 * in Zotero on an earlier send.
 */
async function settle(z: Zotero, objectKey: string | undefined, version: number | null | undefined, fields: Record<string, unknown>) {
  if (!objectKey) return 'missing' as const;
  if (typeof version === 'number' && version > 0) return patchObject(z, objectKey, version, fields);
  const current = await versionOf(z, objectKey);
  if (current === null) return 'missing' as const;
  return version === 0 ? current : 'changed' as const;
}

/**
 * The item is updated even after the reader edited it in Zotero: a PATCH
 * sends only the citation fields, so their tags, collections and notes stay.
 */
async function updateItem(z: Zotero, itemKey: string | undefined, version: number | null | undefined, item: Record<string, unknown>) {
  if (!itemKey) return 'missing' as const;
  const state = await settle(z, itemKey, version, item);
  if (state !== 'changed') return state;
  const current = await versionOf(z, itemKey);
  if (current === null) return 'missing' as const;
  const retried = await patchObject(z, itemKey, current, item);
  return retried === 'changed' ? 'kept' as const : retried;
}

/** Best effort: the key is already forgotten here whether or not Zotero hears of it. */
async function revokeKey(env: WorkerEnv, sealed: string, budget: AbortSignal) {
  await unseal(env, sealed)
    .then(key => apiRequest({ key, budget }, 'DELETE', `/keys/${encodeURIComponent(key)}`))
    .catch(() => {});
}
