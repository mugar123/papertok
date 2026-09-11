import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COMMENT_COUNT_CAP,
  COMMENT_PAGE_SIZE,
  CommentUnsupportedError,
  createComment,
  deleteComment,
  editComment,
  fetchCommentCount,
  fetchMyCommentsPage,
  fetchThreadPage,
  groupThread,
} from './commentService.js';
import { keyFromIdentity } from '../utils/paperCanonicalKey.js';

function fakeBatch(log) {
  return {
    set: (ref, data, options) => log.push({ op: 'set', path: ref.path, data, options }),
    delete: ref => log.push({ op: 'delete', path: ref.path }),
    commit: async () => { log.push({ op: 'commit' }); },
  };
}

function api(overrides = {}) {
  const log = overrides.log || [];
  return {
    log,
    currentUser: { uid: 'u1' },
    isDemo: false,
    document: (database, ...path) => ({ path: path.join('/') }),
    newCommentRef: (database, paperKey) => ({
      path: `papers/${paperKey}/comments/auto-1`, id: 'auto-1',
    }),
    batch: () => fakeBatch(log),
    now: () => 'NOW',
    countIncrement: amount => ({ increment: amount }),
    ...overrides,
  };
}

const ANCHOR = { key: 'K', identity: 'arxiv:2401.12345', stubExists: true, alternates: [] };
const PAPER = { title: 'T', arxivId: '2401.12345' };

// --- createComment ---------------------------------------------------------

test('a comment on an existing thread batches exactly comment + stamp', async () => {
  const spy = api();
  const result = await createComment(
    { anchor: ANCHOR, paper: PAPER, authorHandle: 'alice', text: '  Hello  ' },
    spy,
  );
  const ops = spy.log.filter(entry => entry.op === 'set');
  assert.equal(ops.length, 2);
  assert.equal(ops[0].path, 'papers/K/comments/auto-1');
  assert.deepEqual(ops[0].data, {
    authorUid: 'u1', authorHandle: 'alice', text: 'Hello',
    status: 'visible', createdAt: 'NOW',
  });
  assert.equal(ops[1].path, 'users/u1/rateLimits/comments');
  assert.equal(ops[1].data.lastAt, 'NOW');
  // The stamp names the comment it vouches for: the rules refuse a stamp
  // that does not, and a batch cannot stamp twice (finding 7a).
  assert.equal(ops[1].data.lastId, 'auto-1');
  assert.deepEqual(ops[1].options, { merge: true });
  assert.equal(result.id, 'auto-1');
});

test('the first comment creates the stub and both stamps in one commit', async () => {
  const anchor = {
    key: keyFromIdentity('arxiv:2401.12345'),
    identity: 'arxiv:2401.12345', stubExists: false, alternates: [],
  };
  const spy = api();
  await createComment(
    { anchor, paper: PAPER, authorHandle: 'alice', text: 'First!' },
    spy,
  );
  const paths = spy.log.filter(entry => entry.op === 'set').map(entry => entry.path);
  assert.deepEqual(paths, [
    `papers/${anchor.key}`,
    'users/u1/rateLimits/stubs',
    `papers/${anchor.key}/comments/auto-1`,
    'users/u1/rateLimits/comments',
  ]);
  const stub = spy.log[0].data;
  assert.equal(stub.canonicalKey, 'arxiv:2401.12345');
  assert.equal(stub.createdBy, 'u1');
  assert.equal(stub.createdAt, 'NOW');
  const stamps = spy.log.filter(entry => entry.op === 'set' && entry.path.includes('/rateLimits/'));
  assert.deepEqual(stamps.map(entry => entry.data.lastId), [anchor.key, 'auto-1'],
    'the stub stamp names the stub, the comment stamp names the comment');
  assert.equal(spy.log.filter(entry => entry.op === 'commit').length, 1);
});

test('a reply carries its parent id; top-level comments carry no replyTo at all', async () => {
  const spy = api();
  await createComment(
    { anchor: ANCHOR, paper: PAPER, authorHandle: 'a', text: 'Re', replyTo: 'parent-1' },
    spy,
  );
  assert.equal(spy.log[0].data.replyTo, 'parent-1');
  const spy2 = api();
  await createComment({ anchor: ANCHOR, paper: PAPER, authorHandle: 'a', text: 'Top' }, spy2);
  assert.equal('replyTo' in spy2.log[0].data, false,
    'an explicit null would trip the rules; absence is the contract');
});

test('a stub that cannot be built or does not match the anchor refuses to write', async () => {
  const anchor = { key: 'K', identity: 'arxiv:2401.12345', stubExists: false, alternates: [] };
  await assert.rejects(
    createComment({ anchor, paper: { title: 'Other', doi: '10.1/x' }, authorHandle: 'a', text: 'x' }, api()),
    /cannot anchor/,
  );
  await assert.rejects(
    createComment({ anchor, paper: { title: '' }, authorHandle: 'a', text: 'x' }, api()),
    /cannot anchor/,
  );
});

test('text is required, trimmed, and bounded; the handle snapshot is required', async () => {
  await assert.rejects(
    createComment({ anchor: ANCHOR, paper: PAPER, authorHandle: 'a', text: '   ' }, api()),
    /needs text/,
  );
  await assert.rejects(
    createComment({ anchor: ANCHOR, paper: PAPER, authorHandle: 'a', text: 'x'.repeat(4001) }, api()),
    /cannot exceed/,
  );
  await assert.rejects(
    createComment({ anchor: ANCHOR, paper: PAPER, authorHandle: '', text: 'ok' }, api()),
    /handle snapshot/,
  );
});

test('demo mode and signed-out callers are refused before any write', async () => {
  await assert.rejects(
    createComment({ anchor: ANCHOR, paper: PAPER, authorHandle: 'a', text: 'x' },
      api({ isDemo: true })),
    CommentUnsupportedError,
  );
  await assert.rejects(
    createComment({ anchor: ANCHOR, paper: PAPER, authorHandle: 'a', text: 'x' },
      api({ currentUser: null })),
    /Authentication/,
  );
});

// --- editComment -----------------------------------------------------------

test('an edit rewrites text and stamps editedAt with the server clock', async () => {
  const updates = [];
  await editComment('K', 'c1', ' New text ', api({
    updateDocument: async (ref, data) => updates.push({ path: ref.path, data }),
  }));
  assert.deepEqual(updates, [{
    path: 'papers/K/comments/c1',
    data: { text: 'New text', editedAt: 'NOW' },
  }]);
});

// --- deleteComment: the cascade --------------------------------------------

test('deleting a reply is one delete, no queries', async () => {
  const spy = api({
    readReplyPage: async () => { throw new Error('must not query'); },
    deleteDocument: async ref => spy.log.push({ op: 'delete', path: ref.path }),
  });
  const result = await deleteComment({ paperKey: 'K', commentId: 'r1', isReply: true }, spy);
  assert.deepEqual(spy.log, [{ op: 'delete', path: 'papers/K/comments/r1' }]);
  assert.equal(result.deleted, 1);
});

test('deleting a parent sweeps parent plus replies in one batch when they fit', async () => {
  const spy = api({
    readReplyPage: async () => [{ id: 'r1' }, { id: 'r2' }],
  });
  const result = await deleteComment({ paperKey: 'K', commentId: 'p1' }, spy);
  const deletes = spy.log.filter(entry => entry.op === 'delete').map(entry => entry.path);
  assert.deepEqual(deletes, [
    'papers/K/comments/p1', 'papers/K/comments/r1', 'papers/K/comments/r2',
  ]);
  assert.equal(spy.log.filter(entry => entry.op === 'commit').length, 1,
    'parent and replies fall atomically');
  assert.equal(result.deleted, 3);
});

test('an overfull thread cascades in bounded batches, parent first', async () => {
  // First page full (400), second page the remainder: two commits, no
  // unbounded query, and the parent goes down in the first batch so later
  // batches ride the orphan-sweep rule.
  const pages = [
    Array.from({ length: 400 }, (unused, index) => ({ id: `r${index}` })),
    [{ id: 'r400' }],
  ];
  const spy = api({ readReplyPage: async () => pages.shift() ?? [] });
  const result = await deleteComment({ paperKey: 'K', commentId: 'p1' }, spy);
  const commits = spy.log.filter(entry => entry.op === 'commit').length;
  assert.equal(commits, 2);
  assert.equal(result.deleted, 402);
  assert.equal(spy.log[0].op, 'delete');
  assert.equal(spy.log[0].path, 'papers/K/comments/p1');
});

test('deleting a parent with no replies is one batch of one', async () => {
  const spy = api({ readReplyPage: async () => [] });
  const result = await deleteComment({ paperKey: 'K', commentId: 'p1' }, spy);
  assert.equal(result.deleted, 1);
  assert.equal(spy.log.filter(entry => entry.op === 'commit').length, 1);
});

// --- reading ---------------------------------------------------------------

test('a thread page is bounded, oldest first, with an opaque cursor', async () => {
  const rows = Array.from({ length: COMMENT_PAGE_SIZE }, (unused, index) => ({
    id: `c${index}`, data: { text: String(index) }, cursor: `cur${index}`,
  }));
  const calls = [];
  const page = await fetchThreadPage('K', {}, api({
    readThreadPage: async (database, paperKey, size, cursor) => {
      calls.push({ paperKey, size, cursor });
      return rows;
    },
  }));
  assert.deepEqual(calls, [{ paperKey: 'K', size: COMMENT_PAGE_SIZE, cursor: null }]);
  assert.equal(page.comments.length, COMMENT_PAGE_SIZE);
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, `cur${COMMENT_PAGE_SIZE - 1}`);
  const short = await fetchThreadPage('K', {}, api({ readThreadPage: async () => rows.slice(0, 3) }));
  assert.equal(short.hasMore, false);
  assert.equal(short.cursor, null);
});

test('a requested page size cannot exceed the service ceiling', async () => {
  const sizes = [];
  await fetchThreadPage('K', { pageSize: 500 }, api({
    readThreadPage: async (database, paperKey, size) => { sizes.push(size); return []; },
  }));
  assert.deepEqual(sizes, [COMMENT_PAGE_SIZE]);
});

test('the comment count is capped and says so', async () => {
  const capped = await fetchCommentCount('K', api({ countThread: async () => 5000 }));
  assert.deepEqual(capped, { count: COMMENT_COUNT_CAP, capped: true });
  const plain = await fetchCommentCount('K', api({ countThread: async () => 7 }));
  assert.deepEqual(plain, { count: 7, capped: false });
});

test('my comments come back with the thread key their path names', async () => {
  const page = await fetchMyCommentsPage({}, api({
    readAuthorPage: async () => ({
      fromCache: false,
      rows: [{ id: 'c1', paperKey: 'K1', data: { text: 'a', status: 'hidden' }, cursor: 'x' }],
    }),
  }));
  assert.equal(page.comments[0].paperKey, 'K1');
  assert.equal(page.comments[0].status, 'hidden',
    'hidden comments surface here — it is where the author learns of moderation');
  assert.equal(page.fromCache, false);
});

test('an empty answer carries where it came from', async () => {
  const cached = await fetchMyCommentsPage({}, api({
    readAuthorPage: async () => ({ fromCache: true, rows: [] }),
  }));
  assert.deepEqual(cached, { comments: [], cursor: null, hasMore: false, fromCache: true });

  const server = await fetchMyCommentsPage({}, api({
    readAuthorPage: async () => ({ fromCache: false, rows: [] }),
  }));
  assert.equal(server.fromCache, false);
});

test('a missing fromCache flag counts as a server answer', async () => {
  const page = await fetchMyCommentsPage({}, api({ readAuthorPage: async () => ({ rows: [] }) }));
  assert.equal(page.fromCache, false);
});

// --- groupThread -----------------------------------------------------------

test('grouping keeps arrival order and attaches replies to their parents', () => {
  const grouped = groupThread([
    { id: 'a', text: '1' },
    { id: 'b', text: '2' },
    { id: 'r1', replyTo: 'a', text: '3' },
    { id: 'r2', replyTo: 'a', text: '4' },
    { id: 'r3', replyTo: 'ghost', text: 'orphan' },
  ]);
  assert.deepEqual(grouped.map(entry => entry.id), ['a', 'b']);
  assert.deepEqual(grouped[0].replies.map(entry => entry.id), ['r1', 'r2']);
  assert.equal(grouped[1].replies.length, 0);
  const flattened = grouped.flatMap(entry => [entry.id, ...entry.replies.map(reply => reply.id)]);
  assert.equal(flattened.includes('r3'), false, 'an orphan never renders floating');
});

// --- structural ------------------------------------------------------------

test('SOURCE: no query in this service is issued without a ceiling', async () => {
  const source = await readFile(new URL('./commentService.js', import.meta.url), 'utf8');
  const queries = source.match(/query\(\s*\n?[\s\S]*?\n\s*\)\)/g) || [];
  assert.ok(queries.length > 0, 'expected at least one query to guard');
  for (const shape of queries) {
    assert.match(shape, /limit\(/, `unbounded query: ${shape}`);
  }
  assert.doesNotMatch(source, /getDocs\((?!query\()/, 'every getDocs goes through a bounded query');
  assert.doesNotMatch(
    source,
    /getCountFromServer\((?!query\()/,
    'every aggregation goes through a bounded query',
  );
});

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
/**
 * Every module a file pulls in, however it names what it takes — named,
 * default, namespace (all three write `from '…'`/`from "…"`) or a bare
 * side-effect `import '…';` with no `from` clause at all. Both quote styles
 * on purpose: `eslint.config.js` carries no `quotes` rule, so nothing else in
 * this repo stops a new import from arriving double-quoted, and a scan that
 * only recognised single quotes would let it through uncounted.
 */
const specifiersOf = (source) => [...new Set(
  [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(hit => hit[1]),
)].sort();
/** The names taken by name from one specifier. */
const namesFrom = (source, specifier) => {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = source.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`));
  assert.ok(hit, `expected a named import from ${specifier}`);
  return hit[1].split(',').map(name => name.trim()).filter(Boolean).sort();
};

test('SOURCE: nothing on the feed path imports any social service', async () => {
  // The feed-load invariant (one document read), asserted where it can
  // actually break: an import. Superset of the followUserService guard.
  // Comments are stripped first — the claim is about code. A file naming this
  // guard in prose (PaperCard.jsx does, to say where its one sanctioned door
  // is held shut) must not read as an import of the thing it is explaining.
  for (const path of [
    '../context/FeedContext.jsx',
    '../components/Feed/FeedContainer.jsx',
    '../components/Feed/PaperCard.jsx',
    '../utils/interactionProfileLoader.js',
    '../services/interactionProfileStore.js',
  ]) {
    const source = stripComments(await readSource(path));
    assert.doesNotMatch(
      source,
      /followUserService|commentService|paperStubService|reportService|userSearchService/,
      `${path} must stay off the social collections`,
    );
  }
});

/**
 * The one sanctioned crack in the wall above, and the fence that keeps it one.
 *
 * Task 9 put a comment count on the card's button, so the feed path now does
 * reach this file — PaperCard -> hooks/useCommentCount.js -> commentService
 * (which itself imports paperStubService) and -> threadAnchorClient. The scan
 * above only sees DIRECT imports, so it goes on passing while the module graph
 * underneath it has changed: a `fetchThreadPage`, or a stub write, added to
 * that hook would cost the feed reads with nothing failing.
 *
 * What is sanctioned is narrow and worth stating exactly: a feed LOAD still
 * costs one document read; the aggregation fires after the card is mounted,
 * for the ONE card the feed says is active, at most twice per paper per
 * session. Both halves of that are asserted here — the hook's only door into
 * Firestore, and the gate on the call — because they are the whole budget and
 * nothing else in the suite watches either of them.
 */
test('SOURCE: the card counts comments through one door, and only when active', async () => {
  const hook = stripComments(await readSource('../hooks/useCommentCount.js'));
  assert.deepEqual(
    specifiersOf(hook),
    ['../services/commentService.js', '../services/threadAnchorClient.js', 'react'],
    'a new import into this hook is a change to the feed\'s read budget: weigh it, then update this list',
  );
  assert.deepEqual(
    namesFrom(hook, '../services/commentService.js'),
    ['COMMENT_COUNT_CAP', 'fetchCommentCount'],
    'the capped count is the hook\'s only Firestore entry point (COMMENT_COUNT_CAP is a number, not a read)',
  );
  assert.doesNotMatch(hook, /firebase/, 'and it never reaches past the service to Firestore itself');

  // The line the whole budget rests on, read where it is written: bounded to
  // the call itself so the match cannot drift into the code around it. Every
  // occurrence, not just the first — a second, ungated call added after this
  // one must fail the same way the first would.
  const card = stripComments(await readSource('../components/Feed/PaperCard.jsx'));
  const calls = [...card.matchAll(/useCommentCount\([^;]{0,160}?\);/g)];
  assert.ok(calls.length > 0, 'PaperCard must call useCommentCount');
  for (const call of calls) {
    assert.match(
      call[0],
      /^useCommentCount\(paper, Boolean\(isActive && canOpenComments\)\);$/,
      'the count is gated on the active card that can open a thread — nothing else may fire a read',
    );
  }
});
