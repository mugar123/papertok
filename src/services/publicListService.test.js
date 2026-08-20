import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PUBLIC_LIST_LIMITS,
  PublicListRequestError,
  PublicListUnsupportedError,
  publishPublicList,
  readPublicList,
  sanitizePublicList,
  unpublishPublicList,
  updatePublicList,
} from './publicListService.js';

const privatePaper = {
  id: 'provider-secret-id',
  title: '  Public   title  ',
  authors: [{ name: 'Ada Lovelace', email: 'ada@example.test' }, 'Grace Hopper'],
  summary: 'A real abstract.',
  year: 2026,
  published: '2026-08-13',
  primaryCategory: 'cs.AI',
  concepts: [{ display_name: 'Machine Learning', score: 0.99 }],
  citationCount: 12,
  doi: 'https://doi.org/10.1000/Example',
  landingPageUrl: 'https://publisher.example/paper',
  note: 'private note',
  tags: ['private-tag'],
  email: 'owner@example.test',
  profile: { displayName: 'Owner' },
  preferences: ['secret'],
  read: true,
  saved: true,
};

/**
 * Reading still goes to Firestore; writing goes to the Worker. The double
 * covers both so a test can assert on whichever half it cares about.
 */
function fakeApi(overrides = {}) {
  const requests = [];
  const responses = overrides.responses || [];
  return {
    requests,
    api: {
      database: 'db',
      isDemo: false,
      apiBase: 'https://worker.test',
      document: (...parts) => parts.join('/'),
      getDocument: async () => ({
        exists: () => true,
        id: '07070707070707070707070707070707',
        data: () => ({ title: 'Shared', papers: [] }),
      }),
      request: async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        const next = responses.shift();
        if (next) return next;
        return new Response(JSON.stringify({
          shareId: '07070707070707070707070707070707',
        }), { status: 200 });
      },
      ...overrides.api,
    },
  };
}

test('sanitizes public lists to the bounded public contract', () => {
  const result = sanitizePublicList({
    name: '  Reading   list ',
    description: 'A curated list.',
    language: 'en',
    papers: [privatePaper],
    listId: 'private-list-id',
    publicShareId: 'private-share-id',
    email: 'owner@example.test',
    notes: ['private'],
  });

  assert.deepEqual(Object.keys(result), [
    'title', 'description', 'language', 'paperCount', 'papers',
  ]);
  assert.equal(result.title, 'Reading list');
  assert.equal(result.paperCount, 1);
  assert.deepEqual(result.papers[0], {
    id: 'doi:10.1000/example',
    title: 'Public title',
    authors: ['Ada Lovelace', 'Grace Hopper'],
    abstract: 'A real abstract.',
    year: 2026,
    date: '2026-08-13',
    category: 'cs.AI',
    concepts: ['Machine Learning'],
    citations: 12,
    doi: '10.1000/Example',
    openUrl: 'https://publisher.example/paper',
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    'private note', 'private-tag', 'owner@example.test', 'preferences', 'saved',
    'private-list-id', 'private-share-id', 'owner-1',
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('drops invalid papers and bounds paper arrays', () => {
  // One over the cap, and a first entry with no title so the drop is visible.
  const size = PUBLIC_LIST_LIMITS.papers + 2;
  const papers = Array.from({ length: size }, (_, index) => ({
    id: `paper-${index}`,
    title: index === 0 ? '' : `Paper ${index}`,
  }));
  const result = sanitizePublicList({ title: 'Bounded', papers });
  assert.equal(result.papers.length, PUBLIC_LIST_LIMITS.papers);
  assert.equal(result.paperCount, PUBLIC_LIST_LIMITS.papers);
  assert.equal(result.papers[0].id, 'paper-1');
});

test('publishing posts the sanitized list to the Worker, never to Firestore', async () => {
  const { api, requests } = fakeApi();
  const published = await publishPublicList(
    { listId: 'list-1', title: 'Shared', papers: [privatePaper] }, api,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://worker.test/lists/publish');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].body.listId, 'list-1');
  assert.equal(requests[0].body.title, 'Shared');
  // The share id is the Worker's to mint: the browser must not choose it, or a
  // caller could aim a publish at somebody else's link.
  assert.equal('shareId' in requests[0].body, false);
  assert.equal('ownerId' in requests[0].body, false);
  assert.equal(published.shareId, '07070707070707070707070707070707');

  // Private fields are stripped before the payload ever leaves the browser.
  const serialized = JSON.stringify(requests[0].body);
  for (const privateValue of ['private note', 'private-tag', 'owner@example.test']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('updating names the share it is editing and sends no timestamps', async () => {
  const shareId = '07070707070707070707070707070707';
  const { api, requests } = fakeApi();
  await updatePublicList(shareId, { listId: 'list-1', title: 'Updated', papers: [] }, api);

  assert.equal(requests[0].url, 'https://worker.test/lists/update');
  assert.equal(requests[0].body.shareId, shareId);
  assert.equal(requests[0].body.title, 'Updated');
  // createdAt and updatedAt are the server's business, not the browser's.
  assert.equal('createdAt' in requests[0].body, false);
  assert.equal('updatedAt' in requests[0].body, false);
});

test('unpublishing sends the share and the private list it belongs to', async () => {
  const shareId = '07070707070707070707070707070707';
  const { api, requests } = fakeApi();
  await unpublishPublicList(shareId, 'list-1', api);
  assert.equal(requests[0].url, 'https://worker.test/lists/unpublish');
  assert.deepEqual(requests[0].body, { shareId, listId: 'list-1' });
});

test('the Worker error code reaches the UI instead of a blank failure', async () => {
  const { api } = fakeApi({
    responses: [new Response(JSON.stringify({ code: 'PUBLISH_QUOTA_EXCEEDED' }), { status: 429 })],
  });
  await assert.rejects(
    () => publishPublicList({ listId: 'list-1', title: 'T', papers: [] }, api),
    error => error instanceof PublicListRequestError
      && error.code === 'PUBLISH_QUOTA_EXCEEDED'
      && error.status === 429,
  );
});

test('an unconfigured Worker origin is reported, not silently swallowed', async () => {
  const { api } = fakeApi({ api: { apiBase: '' } });
  await assert.rejects(
    () => publishPublicList({ listId: 'list-1', title: 'T', papers: [] }, api),
    error => error.code === 'PUBLISHING_NOT_CONFIGURED' && error.status === 503,
  );
});

test('reading a share link is still one Firestore document, with no session', async () => {
  const { api, requests } = fakeApi();
  const shareId = '07070707070707070707070707070707';
  assert.deepEqual(await readPublicList(shareId, api), {
    shareId,
    title: 'Shared',
    papers: [],
  });
  assert.equal(requests.length, 0, 'reading must not go through the Worker');
});

test('a malformed share id or list id never reaches the network', async () => {
  const { api, requests } = fakeApi();
  await assert.rejects(() => updatePublicList('nope', { listId: 'l1', title: 'T' }, api), TypeError);
  await assert.rejects(() => unpublishPublicList('a'.repeat(32), 'a/b', api), TypeError);
  assert.equal(requests.length, 0);
});

test('returns a clear unsupported error in demo mode, on every path', async () => {
  const shareId = '07070707070707070707070707070707';
  const isUnsupported = error => error instanceof PublicListUnsupportedError
    && error.code === 'PUBLIC_LISTS_UNSUPPORTED_IN_DEMO';
  const { api, requests } = fakeApi({ api: { isDemo: true } });

  await assert.rejects(() => readPublicList(shareId, api), isUnsupported);
  await assert.rejects(
    () => publishPublicList({ listId: 'l1', title: 'T', papers: [] }, api), isUnsupported,
  );
  await assert.rejects(
    () => updatePublicList(shareId, { listId: 'l1', title: 'T', papers: [] }, api), isUnsupported,
  );
  await assert.rejects(() => unpublishPublicList(shareId, 'l1', api), isUnsupported);
  assert.equal(requests.length, 0, 'demo mode must not reach the Worker either');
});

test('Firestore rules keep public lists readable and shut to every client', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const publicListRule = rules.match(/match \/publicLists\/\{shareId\}[\s\S]*?\n\s{4}}/)?.[0] || '';
  const ownerRule = rules.match(/match \/publicListOwners\/\{shareId\}[\s\S]*?\n\s{4}}/)?.[0] || '';

  // A share link stays public and stays one document.
  assert.match(publicListRule, /allow get: if true/);
  // Paging it is not a feature, and never was.
  assert.match(publicListRule, /allow list: if false/);
  // Every write comes from the Worker now.
  assert.match(publicListRule, /allow write: if false/);
  assert.match(ownerRule, /allow read: if false/);
  assert.match(ownerRule, /allow write: if false/);

  // The per-paper validators are gone; leaving them would be dead weight that
  // reads like a live guarantee.
  assert.doesNotMatch(rules, /function validPublicPaper/);
  assert.doesNotMatch(rules, /function validPublicList/);
  // But the shared helper stays: savedPapers still uses it.
  assert.match(rules, /function validBoundedStringList/);
  assert.match(rules, /validBoundedStringList\(request\.resource\.data\.authors, 20, 160\)/);

  // The pointer is the Worker's, and the delete rule leans on that.
  assert.match(rules, /function publicShareIdUntouched\(\)/);
  assert.match(rules, /allow delete: if ownsUserTree\(userId\)\s*\n\s*&& !\('publicShareId' in resource\.data\)/);
});

/**
 * A share link is somebody else's list. Telling a visitor it does not exist,
 * when the truth is that this tab never reached the backend, is the worst of
 * the three things the page can say — and it is what happened: `getDoc`
 * resolves against the in-memory cache instead of rejecting, so a missing
 * document and an unreachable backend were the same value.
 */
function readerReturning(snapshot) {
  return {
    database: 'db',
    isDemo: false,
    apiBase: 'https://worker.test',
    document: (...parts) => parts.join('/'),
    getDocument: async () => snapshot,
  };
}

const SHARE_ID = '07070707070707070707070707070707';

test('a public list the server confirmed is missing really is not found', async () => {
  const result = await readPublicList(SHARE_ID, readerReturning({
    exists: () => false,
    metadata: { fromCache: false },
  }));

  assert.equal(result, null, 'the server said so, so null is the answer');
});

test('THE BUG: a cache-served miss is not a missing list', async () => {
  await assert.rejects(
    () => readPublicList(SHARE_ID, readerReturning({
      exists: () => false,
      metadata: { fromCache: true },
    })),
    (error) => {
      assert.equal(error.code, 'PUBLIC_LIST_UNAVAILABLE');
      assert.equal(error.retryable, true);
      return true;
    },
    'nobody confirmed this list is gone — the backend never answered',
  );
});

test('a list served from the cache is still a list', async () => {
  const result = await readPublicList(SHARE_ID, readerReturning({
    exists: () => true,
    id: SHARE_ID,
    metadata: { fromCache: true },
    data: () => ({ title: 'Shared', papers: [] }),
  }));

  assert.equal(result.title, 'Shared', 'data in hand is data, cached or not');
});
