import type { FirestoreData, FirestoreWrite } from './firestore-admin.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { decodeFields } from './firestore-admin.ts';
import { ZoteroError, handleZoteroRequest, highlightsNote, oauthHeader, zoteroItem, normalizeZoteroPaper } from './zotero.ts';

const UID = 'alice-uid';
const PROJECT_ID = 'papertok-168df';
const TOKEN = fakeIdToken({ aud: PROJECT_ID, sub: UID });
const ORIGIN = 'https://papertok.app';
const ENV = {
  FIREBASE_WEB_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@test.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
  ZOTERO_CLIENT_KEY: 'client-key',
  ZOTERO_CLIENT_SECRET: 'client-secret',
  ZOTERO_TOKEN_KEY: 'a-disposable-sealing-key-for-tests-only',
};
const PAPER = { id: 'arxiv:2501.00001', title: 'A Paper', authors: ['Ada Lovelace'], date: '2025-01-02', arxivId: '2501.00001', abstract: 'Original abstract.', preprint: true };

function memoryAdmin(seed: Record<string, FirestoreData> = {}) {
  const documents: Record<string, FirestoreData> = { ...seed };
  const path = (name: string) => name.split('/documents/')[1];
  return {
    documents,
    name: (segments: string[]) => `projects/${PROJECT_ID}/databases/(default)/documents/${segments.join('/')}`,
    async getDocument<T>(segments: string[]) { return (documents[segments.join('/')] ?? null) as T | null; },
    async runQuery({ parentSegments = [], collectionId = '', where }: { parentSegments?: string[]; collectionId?: string; where?: { field: string; value: unknown } }) {
      const prefix = `${[...parentSegments, collectionId].join('/')}/`;
      return Object.entries(documents)
        .filter(([key, data]) => key.startsWith(prefix) && (!where || data[where.field] === where.value))
        .map(([key, data]) => ({ id: key.slice(prefix.length), data, path: key.split('/') }));
    },
    async commit(writes: FirestoreWrite[]) {
      for (const write of writes) {
        if (write.delete) { delete documents[path(write.delete)]; continue; }
        const key = path(write.update!.name);
        const fields = decodeFields(write.update!.fields);
        if (!write.updateMask) { documents[key] = fields; continue; }
        const next = { ...(documents[key] || {}) };
        for (const field of write.updateMask.fieldPaths) next[field] = fields[field];
        documents[key] = next;
      }
    },
  };
}

type Handler = (url: string, init: RequestInit) => Response;

function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('accounts:lookup')) {
      return new Response(JSON.stringify({ users: [{ localId: UID, email: 'alice@example.com', emailVerified: true }] }), { status: 200 });
    }
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function request(path: string, body?: unknown) {
  return new Request(`https://worker.test${path}`, {
    method: body === undefined && path === '/zotero/status' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: ORIGIN },
    ...(body === undefined && path === '/zotero/status' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

async function connected(admin: ReturnType<typeof memoryAdmin>) {
  const upstream = stubFetch(url => (url.endsWith('/oauth/request')
    ? new Response('oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true')
    : new Response('oauth_token=api-key&oauth_token_secret=api-key&userID=12345&username=ada')));
  try {
    await handleZoteroRequest(request('/zotero/connect'), ENV, ORIGIN, { admin });
    await handleZoteroRequest(request('/zotero/complete', { oauthToken: 'req-token', oauthVerifier: 'verifier' }), ENV, ORIGIN, { admin });
  } finally {
    upstream.restore();
  }
}

test('signs an OAuth 1.0a request as the published HMAC-SHA1 example does', async () => {
  const header = await oauthHeader('POST', 'https://api.twitter.com/1.1/statuses/update.json', {
    include_entities: 'true',
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
    oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    oauth_version: '1.0',
  }, 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE');
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test('connects only the account that started the exchange, and keeps the key sealed', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(url => (url.endsWith('/oauth/request')
    ? new Response('oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true')
    : new Response('oauth_token=api-key&oauth_token_secret=api-key&userID=12345&username=ada')));
  try {
    const { authorizeUrl } = await handleZoteroRequest(request('/zotero/connect'), ENV, ORIGIN, { admin }) as { authorizeUrl: string };
    const authorize = new URL(authorizeUrl);
    assert.equal(authorize.searchParams.get('oauth_token'), 'req-token');
    assert.equal(authorize.searchParams.get('write_access'), '1');
    assert.equal(authorize.searchParams.get('notes_access'), '1');
    assert.equal(authorize.searchParams.get('all_groups'), 'none');
    assert.match(String(upstream.calls[0].init.headers && (upstream.calls[0].init.headers as Record<string, string>).authorization), /oauth_callback="https%3A%2F%2Fpapertok.app%2Fzotero%2Fcallback"/);

    await assert.rejects(
      handleZoteroRequest(request('/zotero/complete', { oauthToken: 'someone-elses-token', oauthVerifier: 'verifier' }), ENV, ORIGIN, { admin }),
      (error: ZoteroError) => error.code === 'ZOTERO_CONNECTION_EXPIRED',
    );
    assert.deepEqual(await handleZoteroRequest(request('/zotero/complete', { oauthToken: 'req-token', oauthVerifier: 'verifier' }), ENV, ORIGIN, { admin }), { connected: true, username: 'ada' });
  } finally {
    upstream.restore();
  }
  const link = admin.documents[`users/${UID}/zotero/link`];
  assert.equal(link.zoteroUserId, '12345');
  assert.equal(link.pendingToken, undefined);
  assert.ok(typeof link.key === 'string' && !link.key.includes('api-key'));
});

/** Zotero's answer to a create: the object under the key the client chose. */
function created(init: RequestInit, version: number) {
  const [object] = JSON.parse(String(init.body));
  return Response.json({ successful: { 0: { key: object.key, version } } });
}

const record = (admin: ReturnType<typeof memoryAdmin>) => admin.documents[`users/${UID}/zoteroItems/${PAPER.id}`];

test('sends the paper with the reader\'s own highlights, then updates the same item and note', async () => {
  const admin = memoryAdmin({
    [`users/${UID}/highlights/h1`]: { paperId: PAPER.id, kind: 'user', quote: 'A plain quote', note: 'My note', level: 'university', sectionId: 's1', paragraphIndex: 0 },
    [`users/${UID}/highlights/h2`]: { paperId: PAPER.id, kind: 'ai', quote: 'AI finding', note: 'Generated', level: 'university', sectionId: 's1', paragraphIndex: 1 },
  });
  await connected(admin);
  const upstream = stubFetch((_url, init) => (init.method === 'POST'
    ? created(init, 7)
    : new Response(null, { status: 204, headers: { 'last-modified-version': '8' } })));
  try {
    const first = await handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin });
    assert.equal((first as { highlights: number }).highlights, 1);
    const [item, note] = upstream.calls.map(call => JSON.parse(String(call.init.body))[0]);
    assert.equal(item.itemType, 'preprint');
    assert.equal(item.archiveID, 'arXiv:2501.00001');
    assert.match(item.key, /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/);
    assert.equal(note.parentItem, item.key);
    assert.match(note.note, /not from the original text/);
    assert.match(note.note, /My note/);
    assert.doesNotMatch(note.note, /AI finding/);
    assert.equal((upstream.calls[0].init.headers as Record<string, string>)['zotero-api-key'], 'api-key');

    upstream.calls.length = 0;
    await handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin });
    assert.deepEqual(upstream.calls.map(call => [call.init.method, new URL(call.url).pathname]), [
      ['PATCH', `/users/12345/items/${item.key}`],
      ['PATCH', `/users/12345/items/${note.key}`],
    ]);
    assert.equal((upstream.calls[1].init.headers as Record<string, string>)['if-unmodified-since-version'], '7');
  } finally {
    upstream.restore();
  }
});

test('adds a new note instead of overwriting one edited in Zotero', async () => {
  const admin = memoryAdmin({
    [`users/${UID}/highlights/h1`]: { paperId: PAPER.id, kind: 'user', quote: 'A plain quote', level: 'beginner', sectionId: 's1', paragraphIndex: 0 },
    [`users/${UID}/zoteroItems/${PAPER.id}`]: { zoteroUserId: '12345', itemKey: 'ITEMKEY2', itemVersion: 7, itemType: 'preprint', noteKey: 'NTEKEY23', noteVersion: 7 },
  });
  await connected(admin);
  const upstream = stubFetch((url, init) => {
    if (init.method === 'PATCH') return new Response(null, { status: url.endsWith('NTEKEY23') ? 412 : 204, headers: { 'last-modified-version': '9' } });
    return created(init, 9);
  });
  try {
    await handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin });
    assert.deepEqual(upstream.calls.map(call => call.init.method), ['PATCH', 'PATCH', 'POST']);
  } finally {
    upstream.restore();
  }
  assert.notEqual(record(admin).noteKey, 'NTEKEY23');
  assert.equal(record(admin).noteVersion, 9);
});

test('an item edited in Zotero still gets the citation, written over its new version', async () => {
  const admin = memoryAdmin({
    [`users/${UID}/zoteroItems/${PAPER.id}`]: { zoteroUserId: '12345', itemKey: 'ITEMKEY2', itemVersion: 7, itemType: 'preprint' },
  });
  await connected(admin);
  const upstream = stubFetch((_url, init) => {
    if (init.method === 'GET') return Response.json({ ITEMKEY2: 9 });
    const since = (init.headers as Record<string, string>)['if-unmodified-since-version'];
    return new Response(null, { status: since === '7' ? 412 : 204, headers: { 'last-modified-version': '10' } });
  });
  try {
    await handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin });
    assert.deepEqual(upstream.calls.map(call => call.init.method), ['PATCH', 'GET', 'PATCH']);
    assert.equal((upstream.calls[2].init.headers as Record<string, string>)['if-unmodified-since-version'], '9');
  } finally {
    upstream.restore();
  }
  assert.equal(record(admin).itemVersion, 10);
});

test('a create whose answer was lost is looked up by its key, not made a second time', async () => {
  const admin = memoryAdmin();
  await connected(admin);
  let itemKey = '';
  let upstream = stubFetch((_url, init) => {
    itemKey = JSON.parse(String(init.body))[0].key;
    throw new TypeError('connection reset');
  });
  try {
    await assert.rejects(handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin }),
      (error: ZoteroError) => error.code === 'ZOTERO_UNAVAILABLE');
  } finally {
    upstream.restore();
  }
  assert.equal(record(admin).itemKey, itemKey);
  assert.equal(record(admin).itemVersion, 0);

  upstream = stubFetch(url => Response.json({ [itemKey]: 7 }, { status: new URL(url).searchParams.get('format') === 'versions' ? 200 : 500 }));
  try {
    await handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin });
    assert.deepEqual(upstream.calls.map(call => call.init.method), ['GET']);
  } finally {
    upstream.restore();
  }
  assert.equal(record(admin).itemKey, itemKey);
  assert.equal(record(admin).itemVersion, 7);
});

test('a failing lookup is an error, not a missing item to create again', async () => {
  const admin = memoryAdmin({
    [`users/${UID}/zoteroItems/${PAPER.id}`]: { zoteroUserId: '12345', itemKey: 'ITEMKEY2', itemVersion: null, itemType: 'preprint' },
  });
  await connected(admin);
  const upstream = stubFetch(() => new Response('Server error', { status: 500 }));
  try {
    await assert.rejects(handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin }),
      (error: ZoteroError) => error.code === 'ZOTERO_UNAVAILABLE');
    assert.deepEqual(upstream.calls.map(call => call.init.method), ['GET']);
  } finally {
    upstream.restore();
  }
});

test('removing every highlight removes the note PaperTok wrote, but not one edited in Zotero', async () => {
  for (const [status, removed] of [[204, true], [412, false]] as const) {
    const admin = memoryAdmin({
      [`users/${UID}/zoteroItems/${PAPER.id}`]: { zoteroUserId: '12345', itemKey: 'ITEMKEY2', itemVersion: 7, itemType: 'preprint', noteKey: 'NTEKEY23', noteVersion: 7 },
    });
    await connected(admin);
    const upstream = stubFetch((_url, init) => (init.method === 'DELETE'
      ? new Response(null, { status })
      : new Response(null, { status: 204, headers: { 'last-modified-version': '8' } })));
    try {
      await handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin });
      const deleted = upstream.calls.find(call => call.init.method === 'DELETE');
      assert.equal(new URL(deleted!.url).pathname, '/users/12345/items/NTEKEY23');
      assert.equal((deleted!.init.headers as Record<string, string>)['if-unmodified-since-version'], '7');
    } finally {
      upstream.restore();
    }
    assert.equal(record(admin).noteKey, null, removed ? 'a removed note is forgotten' : 'an edited note is left in Zotero and forgotten here');
  }
});

test('a key sealed under a replaced ZOTERO_TOKEN_KEY disconnects the account instead of failing every send', async () => {
  const admin = memoryAdmin();
  await connected(admin);
  const upstream = stubFetch(url => { throw new Error(`unexpected request to ${url}`); });
  try {
    await assert.rejects(
      handleZoteroRequest(request('/zotero/send', { paper: PAPER }), { ...ENV, ZOTERO_TOKEN_KEY: 'another-sealing-key-after-rotation' }, ORIGIN, { admin }),
      (error: ZoteroError) => error.code === 'ZOTERO_NOT_CONNECTED',
    );
  } finally {
    upstream.restore();
  }
  assert.equal(admin.documents[`users/${UID}/zotero/link`], undefined);
});

test('a revoked key disconnects the account, and a busy Zotero says when to retry', async () => {
  const admin = memoryAdmin();
  await connected(admin);
  let upstream = stubFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '30' } }));
  try {
    await assert.rejects(handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin }),
      (error: ZoteroError) => error.code === 'ZOTERO_RATE_LIMITED' && error.retryAfter === '30');
  } finally {
    upstream.restore();
  }
  upstream = stubFetch(() => new Response('Forbidden', { status: 403 }));
  try {
    await assert.rejects(handleZoteroRequest(request('/zotero/send', { paper: PAPER }), ENV, ORIGIN, { admin }),
      (error: ZoteroError) => error.code === 'ZOTERO_NOT_CONNECTED' && error.status === 409);
  } finally {
    upstream.restore();
  }
  assert.equal(admin.documents[`users/${UID}/zotero/link`], undefined);
});

test('files a paper with a known journal as an article, one with none as a document, and refuses a paper without a title', () => {
  const article = zoteroItem(normalizeZoteroPaper({ ...PAPER, preprint: false, journal: 'Nature', pmid: '123' })!);
  assert.equal(article.itemType, 'journalArticle');
  assert.equal((article as { publicationTitle: string }).publicationTitle, 'Nature');
  const document = zoteroItem(normalizeZoteroPaper({ ...PAPER, preprint: false })!);
  assert.equal(document.itemType, 'document');
  assert.equal((document as { extra: string }).extra, 'arXiv: 2501.00001');
  assert.equal(normalizeZoteroPaper({ id: 'x', title: '  ' }), null);
  assert.match(highlightsNote('<b>', [{ quote: '<script>', note: '', level: 'researcher' }]), /&lt;script&gt;/);
});
