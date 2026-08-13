import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PublicListUnsupportedError,
  createPublicListShareId,
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

function fakeApi(overrides = {}) {
  const calls = [];
  const batch = {
    set: (...args) => calls.push(['set', ...args]),
    update: (...args) => calls.push(['update', ...args]),
    delete: (...args) => calls.push(['delete', ...args]),
    commit: async () => calls.push(['commit']),
  };
  return {
    calls,
    api: {
      database: 'db',
      currentUser: { uid: 'owner-1' },
      cryptoApi: { getRandomValues: bytes => bytes.fill(7) },
      document: (...parts) => parts.join('/'),
      batch: () => batch,
      deleteValue: () => 'DELETE_FIELD',
      now: () => 'SERVER_TIME',
      getDocument: async () => ({
        exists: () => true,
        id: '07070707070707070707070707070707',
        data: () => ({ title: 'Shared', papers: [] }),
      }),
      isDemo: false,
      ...overrides,
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
  const papers = Array.from({ length: 45 }, (_, index) => ({
    id: `paper-${index}`,
    title: index === 0 ? '' : `Paper ${index}`,
  }));
  const result = sanitizePublicList({ title: 'Bounded', papers });
  assert.equal(result.papers.length, 12);
  assert.equal(result.paperCount, 12);
  assert.equal(result.papers[0].id, 'paper-1');
});

test('creates 128-bit lowercase hexadecimal share IDs with Web Crypto', () => {
  const id = createPublicListShareId({
    getRandomValues(bytes) {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    },
  });
  assert.equal(id, '000102030405060708090a0b0c0d0e0f');
});

test('publishes and updates without allowing owner mutation', async () => {
  const { api, calls } = fakeApi();
  const published = await publishPublicList({ listId: 'list-1', title: 'Shared', papers: [privatePaper] }, api);
  assert.equal(published.shareId, '07070707070707070707070707070707');
  assert.equal(calls[0][1], 'db/publicListOwners/07070707070707070707070707070707');
  assert.equal(calls[0][2].ownerId, 'owner-1');
  assert.equal(calls[0][2].createdAt, 'SERVER_TIME');
  assert.equal(calls[1][1], 'db/publicLists/07070707070707070707070707070707');
  assert.equal('ownerId' in calls[1][2], false);
  assert.deepEqual(calls[2], [
    'update',
    'db/users/owner-1/lists/list-1',
    { publicShareId: published.shareId },
  ]);
  assert.deepEqual(calls[3], ['commit']);

  await updatePublicList(published.shareId, { listId: 'list-1', title: 'Updated', papers: [] }, api);
  assert.equal(calls[4][0], 'update');
  assert.equal(calls[4][1], 'db/publicLists/07070707070707070707070707070707');
  assert.equal('ownerId' in calls[4][2], false);
  assert.equal('createdAt' in calls[4][2], false);
  assert.equal(calls[4][2].updatedAt, 'SERVER_TIME');
  assert.deepEqual(calls[5][2], { publicShareId: published.shareId });
  assert.deepEqual(calls[6], ['commit']);
});

test('reads public snapshots and deletes only with an authenticated caller', async () => {
  const { api, calls } = fakeApi();
  const shareId = '07070707070707070707070707070707';
  assert.deepEqual(await readPublicList(shareId, api), {
    shareId,
    title: 'Shared',
    papers: [],
  });
  await unpublishPublicList(shareId, 'list-1', api);
  assert.deepEqual(calls.slice(-4), [
    ['delete', `db/publicLists/${shareId}`],
    ['delete', `db/publicListOwners/${shareId}`],
    ['update', 'db/users/owner-1/lists/list-1', { publicShareId: 'DELETE_FIELD' }],
    ['commit'],
  ]);

  await assert.rejects(
    () => unpublishPublicList(shareId, 'list-1', { ...api, currentUser: null }),
    /Authentication is required/,
  );
});

test('returns a clear unsupported error in demo mode', async () => {
  const { api } = fakeApi({ isDemo: true });
  await assert.rejects(
    () => readPublicList('07070707070707070707070707070707', api),
    error => error instanceof PublicListUnsupportedError
      && error.code === 'PUBLIC_LISTS_UNSUPPORTED_IN_DEMO',
  );
});

test('Firestore rules expose reads but keep owner identity and timestamps immutable', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const publicListRule = rules.match(/match \/publicLists\/\{shareId\}[\s\S]*?\n\s{4}}/)?.[0] || '';
  const ownerRule = rules.match(/match \/publicListOwners\/\{shareId\}[\s\S]*?\n\s{4}}/)?.[0] || '';
  assert.match(rules, /match \/publicLists\/\{shareId\}/);
  assert.match(publicListRule, /allow read: if true/);
  assert.doesNotMatch(publicListRule, /ownerId/);
  assert.match(rules, /match \/publicListOwners\/\{shareId\}/);
  assert.match(rules, /request\.resource\.data\.ownerId == request\.auth\.uid/);
  assert.match(rules, /ownsPublicList\(shareId\)/);
  assert.doesNotMatch(ownerRule, /allow read/);
  assert.match(publicListRule, /request\.resource\.data\.createdAt == resource\.data\.createdAt/);
  assert.match(rules, /papers\.size\(\) <= 12/);
  assert.match(rules, /request\.resource\.data\.paperCount == request\.resource\.data\.papers\.size\(\)/);
  assert.match(rules, /'createdAt', 'publicShareId'/);
  assert.match(rules, /publicShareId\.matches\('\^\[a-f0-9\]\{32\}\$'\)/);
  assert.match(rules, /allow delete: if ownsUserTree\(userId\)[\s\S]*?!existsAfter\([\s\S]*?publicLists/);
});
