import test from 'node:test';
import assert from 'node:assert/strict';
import { keyFromIdentity } from '../src/utils/paperCanonicalKey.js';
import {
  THREAD_KV_PREFIX,
  THREAD_KV_THREAD_TTL_SECONDS,
  handleThreadAnchorRequest,
  parseInvalidateKeys,
  parseThreadIdentities,
  resolveThreadAnchorFromStore,
  serializeComment,
  threadKvKey,
} from './thread-anchor.js';

const DOI = 'doi:10.1234/abc';
const ARXIV = 'arxiv:2401.12345';
const DOI_KEY = keyFromIdentity(DOI);
const ARXIV_KEY = keyFromIdentity(ARXIV);

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key, type) {
      const value = data.get(key);
      if (value == null) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, options) {
      // Production KV refuses TTLs under a minute; the fake has to as well, or
      // a TTL that never caches anything passes every test.
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error(`Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least 60.`);
      }
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

test('identities are canonicalised, deduplicated, and capped', () => {
  const parsed = parseThreadIdentities('doi:10.1234/ABC,arxiv:2401.12345v2,doi:10.1234/abc');
  assert.deepEqual(parsed.map(entry => entry.identity), [DOI, ARXIV]);
  assert.equal(parsed[0].key, DOI_KEY);
  assert.throws(() => parseThreadIdentities(''), error => error.code === 'THREAD_IDS_REQUIRED');
  assert.throws(() => parseThreadIdentities('doi:nope'), error => error.code === 'THREAD_IDS_INVALID');
  assert.throws(() => parseThreadIdentities('https://example.com/paper'), error => error.code === 'THREAD_IDS_INVALID');
  assert.throws(
    () => parseThreadIdentities('a,b,c,d,e'),
    error => error.code === 'THREAD_IDS_TOO_MANY',
  );
});

test('invalidate keys refuse path traversal and empty bodies', () => {
  assert.deepEqual(parseInvalidateKeys({ keys: [DOI_KEY, DOI_KEY] }), [DOI_KEY]);
  assert.throws(() => parseInvalidateKeys({ keys: [] }), error => error.code === 'THREAD_KEYS_REQUIRED');
  assert.throws(() => parseInvalidateKeys({ keys: ['papers/../x'] }), error => error.code === 'THREAD_KEYS_INVALID');
});

test('comments serialise timestamps to ISO so the browser can JSON them', () => {
  const row = serializeComment({
    id: 'c1',
    data: {
      authorUid: 'u1',
      authorHandle: 'alice',
      text: 'Hello',
      status: 'visible',
      createdAt: new Date('2026-08-31T12:00:00.000Z'),
      replyTo: 'parent',
    },
  });
  assert.equal(row.createdAt, '2026-08-31T12:00:00.000Z');
  assert.equal(row.replyTo, 'parent');
  assert.equal(serializeComment({ id: 'x', data: { text: '' } }), null);
});

test('a KV hit never asks Firestore, which is the empty-thread win', async () => {
  const store = memoryStore({
    [threadKvKey(DOI_KEY)]: JSON.stringify({
      identity: DOI,
      key: DOI_KEY,
      stubExists: false,
      comments: [],
      hasMore: false,
      count: 0,
      capped: false,
    }),
  });
  const payload = await resolveThreadAnchorFromStore(
    [{ identity: DOI, key: DOI_KEY }],
    {
      store,
      admin: {
        batchGet: async () => { throw new Error('must not read'); },
      },
    },
  );
  assert.equal(payload.stubExists, false);
  assert.equal(payload.cache, 'kv');
  assert.deepEqual(payload.pages, []);
  assert.deepEqual(payload.count, { count: 0, capped: false });
});

test('a miss reads the stub and skips comments when none exist', async () => {
  const store = memoryStore();
  let queries = 0;
  const payload = await resolveThreadAnchorFromStore(
    [{ identity: DOI, key: DOI_KEY }],
    {
      store,
      admin: {
        batchGet: async (docs) => {
          assert.deepEqual(docs, [['papers', DOI_KEY]]);
          return [null];
        },
        runQuery: async () => { queries += 1; return []; },
        countQuery: async () => { queries += 1; return 0; },
      },
    },
  );
  assert.equal(payload.stubExists, false);
  assert.equal(queries, 0, 'an absent stub cannot hold comments');
  assert.equal(payload.cache, 'miss');
  const cached = JSON.parse(store.data.get(threadKvKey(DOI_KEY)));
  assert.equal(cached.stubExists, false);
});

test('an existing stub loads the first page and the capped count', async () => {
  const store = memoryStore();
  const payload = await resolveThreadAnchorFromStore(
    [{ identity: DOI, key: DOI_KEY }],
    {
      store,
      admin: {
        batchGet: async () => [{ canonicalKey: DOI, title: 'A result' }],
        runQuery: async () => ([
          {
            id: 'c1',
            data: {
              authorUid: 'u1',
              authorHandle: 'alice',
              text: 'First',
              status: 'visible',
              createdAt: new Date('2026-08-31T10:00:00.000Z'),
            },
          },
        ]),
        countQuery: async () => 1,
      },
    },
  );
  assert.equal(payload.stubExists, true);
  assert.equal(payload.pages[0].comments[0].text, 'First');
  assert.equal(payload.count.count, 1);
});

test('a dual-identity miss surfaces the alternate that already has a stub', async () => {
  const store = memoryStore();
  const payload = await resolveThreadAnchorFromStore(
    [
      { identity: DOI, key: DOI_KEY },
      { identity: ARXIV, key: ARXIV_KEY },
    ],
    {
      store,
      admin: {
        batchGet: async (docs) => {
          assert.equal(docs.length, 2);
          return [null, { canonicalKey: ARXIV, title: 'Old thread' }];
        },
        runQuery: async ({ parentSegments }) => {
          if (parentSegments[1] === ARXIV_KEY) {
            return [{
              id: 'old',
              data: {
                authorUid: 'u2',
                authorHandle: 'bob',
                text: 'On arXiv',
                status: 'visible',
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
              },
            }];
          }
          return [];
        },
        countQuery: async () => 1,
      },
    },
  );
  assert.equal(payload.key, DOI_KEY, 'new comments still go to the canonical key');
  assert.equal(payload.stubExists, false);
  assert.equal(payload.alternates.length, 1);
  assert.equal(payload.alternates[0].key, ARXIV_KEY);
  assert.equal(payload.pages[0].comments[0].text, 'On arXiv');
});

test('the KV prefix cannot collide with notification keys', () => {
  assert.equal(THREAD_KV_PREFIX, 'thread:v1:');
  assert.ok(!THREAD_KV_PREFIX.startsWith('notification:'));
});

test('HTTP responses are no-store so a KV delete is the actual invalidation', async () => {
  const store = memoryStore({
    [threadKvKey(DOI_KEY)]: JSON.stringify({
      identity: DOI,
      key: DOI_KEY,
      stubExists: false,
      comments: [],
      hasMore: false,
      count: 0,
      capped: false,
    }),
  });
  const response = await handleThreadAnchorRequest(
    new Request(`https://papertok-report-api.example/thread-anchor?ids=${encodeURIComponent(DOI)}`),
    { NOTIFICATION_STORE: store },
    new URL(`https://papertok-report-api.example/thread-anchor?ids=${encodeURIComponent(DOI)}`),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.equal(body.cache, 'kv');
  assert.equal(body.stubExists, false);
});

test('a live thread is cached: its TTL clears the KV floor of 60 s', async () => {
  const store = memoryStore();
  await resolveThreadAnchorFromStore(
    [{ identity: DOI, key: DOI_KEY }],
    {
      store,
      admin: {
        batchGet: async () => [{ canonicalKey: DOI, title: 'A result' }],
        runQuery: async () => ([{
          id: 'c1',
          data: {
            authorUid: 'u1',
            authorHandle: 'alice',
            text: 'First',
            status: 'visible',
            createdAt: new Date('2026-08-31T10:00:00.000Z'),
          },
        }]),
        countQuery: async () => 1,
      },
    },
  );
  assert.ok(
    THREAD_KV_THREAD_TTL_SECONDS >= 60,
    `TTL ${THREAD_KV_THREAD_TTL_SECONDS} is under the KV floor`,
  );
  const cached = await store.get(threadKvKey(DOI_KEY), 'json');
  assert.equal(cached?.stubExists, true, 'the live thread never reached KV');
});
