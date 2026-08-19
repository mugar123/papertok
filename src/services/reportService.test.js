import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REPORT_QUEUE_PAGE_SIZE,
  commentTargetPath,
  fetchOpenReports,
  hideCommentLocally,
  locallyHiddenCommentIds,
  parseCommentTargetPath,
  setCommentVisibility,
  setCommentsFrozen,
  setReportStatus,
  submitReport,
} from './reportService.js';

function fakeBatch(log) {
  return {
    set: (ref, data, options) => log.push({ op: 'set', path: ref.path, data, options }),
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
    newReportRef: () => ({ path: 'reports/auto-1', id: 'auto-1' }),
    batch: () => fakeBatch(log),
    now: () => 'NOW',
    countIncrement: amount => ({ increment: amount }),
    storage: null,
    ...overrides,
  };
}

function fakeStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
}

// --- submitReport ----------------------------------------------------------

test('a report batches the document and its throttle stamp', async () => {
  const spy = api();
  await submitReport({
    targetPath: 'papers/K/comments/c1', targetAuthorUid: 'author-1',
    reason: 'spam', note: '  Linkspam  ',
  }, spy);
  const ops = spy.log.filter(entry => entry.op === 'set');
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].data, {
    reporterUid: 'u1', targetPath: 'papers/K/comments/c1',
    targetAuthorUid: 'author-1', reason: 'spam', note: 'Linkspam',
    status: 'open', createdAt: 'NOW',
  });
  assert.equal(ops[1].path, 'users/u1/rateLimits/reports');
});

test('an empty note is dropped, not written as an empty string', async () => {
  const spy = api();
  await submitReport({
    targetPath: 'papers/K/comments/c1', targetAuthorUid: 'a', reason: 'other', note: '   ',
  }, spy);
  assert.equal('note' in spy.log[0].data, false);
});

test('unknown reasons and paths are refused before any write', async () => {
  await assert.rejects(
    submitReport({ targetPath: 'papers/K/comments/c1', targetAuthorUid: 'a', reason: 'dislike' }, api()),
    /Unknown report reason/,
  );
  await assert.rejects(
    submitReport({ targetPath: '', targetAuthorUid: 'a', reason: 'spam' }, api()),
    /target path/,
  );
});

// --- the admin actions -----------------------------------------------------

test('the queue asks for one bounded FIFO page', async () => {
  const calls = [];
  await fetchOpenReports(api({
    readQueuePage: async (database, pageSize) => { calls.push(pageSize); return []; },
  }));
  assert.deepEqual(calls, [REPORT_QUEUE_PAGE_SIZE]);
});

test('closing a report only accepts the statuses the rules accept', async () => {
  const updates = [];
  const spy = api({ updateDocument: async (ref, data) => updates.push({ path: ref.path, data }) });
  await setReportStatus('r1', 'resolved', spy);
  assert.deepEqual(updates, [{ path: 'reports/r1', data: { status: 'resolved' } }]);
  await assert.rejects(setReportStatus('r1', 'closed', spy), /Unknown report status/);
});

test('hide and show write status to the parsed comment path, nothing else', async () => {
  const updates = [];
  const spy = api({ updateDocument: async (ref, data) => updates.push({ path: ref.path, data }) });
  await setCommentVisibility('papers/K/comments/c1', false, spy);
  await setCommentVisibility('papers/K/comments/c1', true, spy);
  assert.deepEqual(updates, [
    { path: 'papers/K/comments/c1', data: { status: 'hidden' } },
    { path: 'papers/K/comments/c1', data: { status: 'visible' } },
  ]);
});

test('the killswitch write merges one flag with a server timestamp', async () => {
  const sets = [];
  await setCommentsFrozen(true, api({
    setDocument: async (ref, data, options) => sets.push({ path: ref.path, data, options }),
  }));
  assert.deepEqual(sets, [{
    path: 'config/moderation',
    data: { commentsFrozen: true, updatedAt: 'NOW' },
    options: { merge: true },
  }]);
});

// --- target paths: reporter strings must not steer the admin's pen ----------

test('only real comment paths parse; traversal and lookalikes do not', () => {
  assert.deepEqual(
    parseCommentTargetPath('papers/K-1_a/comments/c1'),
    { paperKey: 'K-1_a', commentId: 'c1' },
  );
  for (const hostile of [
    'userProfiles/victim',
    'papers/K/comments/c1/extra',
    'papers/../userProfiles/victim/comments/c1',
    'papers/K/annotations/a1',
    'papers/K/comments/',
    `papers/${'k'.repeat(600)}/comments/c1`,
    '', null, undefined, 42,
  ]) {
    assert.equal(parseCommentTargetPath(hostile), null, String(hostile));
  }
  assert.equal(commentTargetPath('K', 'c1'), 'papers/K/comments/c1');
});

test('setCommentVisibility refuses a path that is not a comment', async () => {
  await assert.rejects(
    setCommentVisibility('userProfiles/victim', false, api()),
    /Not a comment path/,
  );
});

// --- local hiding -----------------------------------------------------------

test('what I report disappears for me, on this device, bounded', () => {
  const storage = fakeStorage();
  hideCommentLocally('c1', { storage });
  hideCommentLocally('c2', { storage });
  hideCommentLocally('c1', { storage });
  const hidden = locallyHiddenCommentIds({ storage });
  assert.deepEqual([...hidden].sort(), ['c1', 'c2']);
  for (let index = 0; index < 400; index += 1) hideCommentLocally(`x${index}`, { storage });
  assert.ok(locallyHiddenCommentIds({ storage }).size <= 300, 'the local list is capped');
});

test('no storage, corrupt storage: hiding degrades to a no-op, never a throw', () => {
  assert.doesNotThrow(() => hideCommentLocally('c1', { storage: null }));
  assert.deepEqual([...locallyHiddenCommentIds({ storage: null })], []);
  const corrupt = { getItem: () => '{not json', setItem: () => { throw new Error('full'); } };
  assert.doesNotThrow(() => hideCommentLocally('c1', { storage: corrupt }));
  assert.deepEqual([...locallyHiddenCommentIds({ storage: corrupt })], []);
});

// --- structural ------------------------------------------------------------

test('SOURCE: no query in this service is issued without a ceiling', async () => {
  const source = await readFile(new URL('./reportService.js', import.meta.url), 'utf8');
  const queries = source.match(/query\(\s*\n?[\s\S]*?\n\s*\)\)/g) || [];
  assert.ok(queries.length > 0, 'expected at least one query to guard');
  for (const shape of queries) {
    assert.match(shape, /limit\(/, `unbounded query: ${shape}`);
  }
  assert.doesNotMatch(source, /getDocs\((?!query\()/, 'every getDocs goes through a bounded query');
});
