import test from 'node:test';
import assert from 'node:assert/strict';
import { keyFromIdentity } from '../utils/paperCanonicalKey.js';
import {
  fetchThreadAnchor,
  hydrateComment,
  invalidateThreadAnchor,
  normalizeThreadAnchorPayload,
} from './threadAnchorClient.js';

const DOI = 'doi:10.1234/abc';
const KEY = keyFromIdentity(DOI);

test('hydrateComment turns ISO timestamps into Dates the sheet can sort', () => {
  const row = hydrateComment({
    id: 'c1',
    authorUid: 'u1',
    authorHandle: 'alice',
    text: 'Hi',
    status: 'visible',
    createdAt: '2026-08-31T12:00:00.000Z',
  }, KEY);
  assert.ok(row.createdAt instanceof Date);
  assert.equal(row.paperKey, KEY);
  assert.equal(hydrateComment({ id: '', text: 'x' }), null);
});

test('the Worker payload becomes the sheet\'s { resolved, keys, pages } tuple', () => {
  const normalized = normalizeThreadAnchorPayload({
    identity: DOI,
    key: KEY,
    stubExists: true,
    alternates: [],
    pages: [{
      key: KEY,
      hasMore: false,
      comments: [{
        id: 'c1',
        authorUid: 'u1',
        authorHandle: 'alice',
        text: 'Hi',
        status: 'visible',
        createdAt: '2026-08-31T12:00:00.000Z',
      }],
    }],
    count: { count: 1, capped: false },
  });
  assert.equal(normalized.resolved.key, KEY);
  assert.equal(normalized.pages[0].comments[0].text, 'Hi');
  assert.equal(normalized.count.count, 1);
  assert.equal(normalizeThreadAnchorPayload({}), null);
});

test('fetchThreadAnchor asks /thread-anchor with canonical ids', async () => {
  let seen = '';
  const result = await fetchThreadAnchor(
    { title: 'T', doi: '10.1234/ABC', arxivId: '2401.12345v2' },
    {
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async (url) => {
        seen = url;
        return new Response(JSON.stringify({
          identity: DOI,
          key: KEY,
          stubExists: false,
          alternates: [],
          pages: [],
          count: { count: 0, capped: false },
        }), { headers: { 'content-type': 'application/json' } });
      },
    },
  );
  assert.match(seen, /\/thread-anchor\?ids=/);
  assert.match(seen, /doi%3A10\.1234%2Fabc/);
  assert.equal(result.resolved.stubExists, false);
  assert.deepEqual(result.count, { count: 0, capped: false });
});

test('an unidentifiable paper never hits the Worker', async () => {
  let called = false;
  const result = await fetchThreadAnchor(
    { title: 'No ids' },
    { apiBase: 'https://papertok-report-api.example', fetchImpl: async () => { called = true; } },
  );
  assert.equal(result, null);
  assert.equal(called, false);
});

test('invalidate is a no-op without a session or keys', async () => {
  assert.equal(await invalidateThreadAnchor([]), false);
  assert.equal(await invalidateThreadAnchor(['k'], { apiBase: '' }), false);
});

test('SOURCE: the comments sheet asks the Worker first', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../components/Comments/CommentsSheet.jsx', import.meta.url), 'utf8');
  assert.match(source, /fetchThreadAnchor/);
  assert.match(source, /invalidateThreadAnchor/);
});

test('SOURCE: the feed still never touches thread resolution', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const path of [
    '../context/FeedContext.jsx',
    '../components/Feed/FeedContainer.jsx',
    '../components/Feed/PaperCard.jsx',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /threadAnchorClient/, `${path} must stay off the comment thread`);
  }
});
