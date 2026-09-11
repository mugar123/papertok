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

test('a full first page from the Worker carries a cursor the sheet can page from', () => {
  const comments = Array.from({ length: 20 }, (unused, index) => ({
    id: `c${index}`,
    authorUid: 'u1',
    authorHandle: 'alice',
    text: String(index),
    status: 'visible',
    createdAt: `2026-08-31T12:00:${String(index).padStart(2, '0')}.000Z`,
  }));
  const full = normalizeThreadAnchorPayload({
    identity: DOI, key: KEY, stubExists: true, alternates: [],
    pages: [{ key: KEY, hasMore: true, comments }],
    count: { count: 45, capped: false },
  });
  assert.deepEqual(full.pages[0].cursor, new Date('2026-08-31T12:00:19.000Z'));

  const short = normalizeThreadAnchorPayload({
    identity: DOI, key: KEY, stubExists: true, alternates: [],
    pages: [{ key: KEY, hasMore: false, comments: comments.slice(0, 3) }],
    count: { count: 3, capped: false },
  });
  assert.equal(short.pages[0].cursor, null);
});

test('SOURCE: paging appends by id, because a value cursor can hand back its own comment', async () => {
  const { readFile } = await import('node:fs/promises');
  const sheet = await readFile(new URL('../components/Comments/CommentsSheet.jsx', import.meta.url), 'utf8');
  // Comments are prose, not code: strip them first, the same way
  // analyticsPageviews.test.js does, so a decoy comment cannot stand in for
  // the real paging call asserted below.
  const code = sheet.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.match(code, /appendNewRows\(previous, fresh\)/);
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

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: the feed still never touches thread resolution', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const path of [
    '../context/FeedContext.jsx',
    '../components/Feed/FeedContainer.jsx',
    '../components/Feed/PaperCard.jsx',
  ]) {
    const source = stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));
    assert.doesNotMatch(source, /threadAnchorClient/, `${path} must stay off the comment thread`);
  }
});

/**
 * Since Task 9 the feed path reaches this file transitively — PaperCard ->
 * hooks/useCommentCount.js -> threadAnchorClient — so the scan above, which
 * only sees direct imports, no longer covers what it used to. The card takes
 * exactly one thing from here, and it is the one thing that costs nothing:
 * `localThreadKeys` is pure string work on the paper already in hand. The two
 * functions beside it, `fetchThreadAnchor` and `invalidateThreadAnchor`, are
 * calls to the Worker — the feed must not gain either, and a card mounted per
 * scroll would put them on a quota shared by every visitor.
 *
 * The gate is asserted here too, not only in commentService.test.js: each
 * guard should stand on its own, and this one's invariant ("the feed does not
 * resolve threads") rests on the same single line.
 */
test('SOURCE: the card takes only the free half of this module', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));
  const hook = await read('../hooks/useCommentCount.js');
  const names = hook.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/services\/threadAnchorClient\.js'/);
  assert.ok(names, 'the hook is the feed path\'s only route into this module');
  assert.deepEqual(
    names[1].split(',').map(name => name.trim()).filter(Boolean).sort(),
    ['localThreadKeys'],
    'no thread resolution and no Worker call may reach the feed through this hook',
  );
  assert.doesNotMatch(hook, /fetchThreadAnchor|invalidateThreadAnchor/);

  // Every occurrence, not just the first — a second, ungated call added
  // after this one must fail the same way the first would.
  const card = await read('../components/Feed/PaperCard.jsx');
  const calls = [...card.matchAll(/useCommentCount\([^;]{0,160}?\);/g)];
  assert.ok(calls.length > 0, 'PaperCard must call useCommentCount');
  for (const call of calls) {
    assert.match(
      call[0],
      /^useCommentCount\(paper, Boolean\(isActive && canOpenComments && !publicMode\)\);$/,
      'and it runs for the active card alone',
    );
  }
});
