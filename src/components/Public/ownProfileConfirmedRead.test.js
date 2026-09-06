import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The own-profile read of /profile (this page in `selfMode`), for the last
 * open door of finding C3 in docs/AUDITORIA-COMENTARIOS-2026-09-05.md.
 *
 * `readOwnUserProfile` RESOLVES `null` for a document the local cache merely
 * failed to find — about half a millisecond, no rejection, on a channel that
 * never opened. This page then wrote that non-answer into `ownProfileCache`
 * through `rememberOwnProfile`, which is exactly the entry the comments
 * sheet seeds its footer from (`seedOwnProfile`), so one visit here with a
 * stalled channel made the sheet tell an account with a public profile to
 * create one, and left this page in its "no profile yet" owner mode.
 *
 * The fix is the same recipe as the sheet, the editor and the warmup: the
 * confirmed read (an unconfirmed absence rejects as `unavailable`), wrapped
 * in `patientRead` so the rejection is retried instead of shown as an error.
 */

// Whole-line `//` comments go first: one of them in this file quotes a route
// glob (`/public/user/*`), which read as a block-comment opener and swallowed
// everything down to the next `*/`, the effect under test included.
const stripComments = source => source
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

const ownProfileEffect = jsx => jsx.match(
  /patientRead\(\(\) => readConfirmedOwnUserProfile\(\)[\s\S]*?controller\.abort\(\);/,
);

test('the own page reads its profile with authority, so a stall is retried instead of settled', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  assert.match(jsx, /readConfirmedOwnUserProfile,/, 'the confirmed sibling is imported');
  assert.equal((jsx.match(/readOwnUserProfile\b/g) || []).length, 0,
    'the plain read is gone from this file: it RESOLVES a cache-served miss, which no patience '
    + 'above it can retry');
  const effect = ownProfileEffect(jsx);
  assert.ok(effect, 'the own read goes through patientRead and aborts on cleanup');
  assert.match(effect[0], /signal: controller\.signal/, 'leaving the page ends the retry loop');
  assert.match(effect[0], /onLateResult: applyOwnProfile/,
    'an answer that lands after the budget still seats the page');
  assert.match(effect[0], /if \(isTransientReadError\(error\)\) \{/,
    "a spent budget is a wait with the loop still running, not the page's failure");
});

test('only a confirmed answer reaches the shared profile cache', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  assert.doesNotMatch(jsx, /rememberOwnProfile\(user\?\.uid, result\)/,
    'the old write-through took whatever the plain read resolved, null included');
  const writes = jsx.match(/rememberOwnProfile\([^)]*\)/g) || [];
  assert.equal(writes.length, 1, 'one write-through, inside the apply function');
  const apply = jsx.match(/const applyOwnProfile = \(ownProfile\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(apply, 'the apply function is what both `.then` and `onLateResult` call');
  assert.match(apply[0], /rememberOwnProfile\(uid, ownProfile\);/,
    'and it is the only place the cache is written, after the server has answered');
});

test('the wait for the profile has to have waited before it says so', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  assert.match(jsx, /import \{[\s\S]*?slowNoticeStatus[\s\S]*?\} from '\.\.\/\.\.\/utils\/boundedRead\.js';/);
  assert.match(jsx, /const startedAt = Date\.now\(\);/, 'the effect stamps when the read began');
  const effect = ownProfileEffect(jsx)[0];
  const onSlow = effect.match(/onSlow: [\s\S]*?onLateResult:/);
  assert.ok(onSlow, 'onSlow comes before onLateResult');
  assert.match(onSlow[0], /slowNoticeStatus\(Date\.now\(\) - startedAt, info\)/,
    'onSlow fires on every transient rejection, and an unconfirmed absence rejects in about half a '
    + 'millisecond: without the gate the skeleton would become "taking longer than usual" inside '
    + 'the first frame');
  assert.doesNotMatch(onSlow[0], /info\?\.offline \? 'offline' : 'slow'/,
    'the offline decision belongs to the gate, which exempts it from the wait');
});

test('a slow wait never replaces a page that is already showing a profile', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  assert.match(jsx, /const WAITING_STATUSES = \['loading', 'slow', 'offline'\];/,
    'the three waits are named once');
  const effect = ownProfileEffect(jsx)[0];
  const onSlow = effect.match(/onSlow: [\s\S]*?onLateResult:/)[0];
  assert.match(onSlow, /setStatus\(current => \(WAITING_STATUSES\.includes\(current\) \? waited : current\)\)/,
    'a seeded page is already `ready`, and a slow revalidation behind it must stay invisible');
});

test('the waits reuse the state page: a title, the same body, and the same Try again', async () => {
  const jsx = await read('./PublicProfilePage.jsx');
  for (const key of ['slowTitle', 'offlineTitle', 'waitingBody']) {
    assert.equal((jsx.match(new RegExp(`^    ${key}: '`, 'gm')) || []).length, 2,
      `${key} exists in both languages`);
  }
  const stateMap = jsx.match(/const state = \{[\s\S]*?\}\[status\];/);
  assert.ok(stateMap, 'the state page still maps status to copy');
  assert.match(stateMap[0], /slow: \{ title: copy\.slowTitle, body: copy\.waitingBody \}/);
  assert.match(stateMap[0], /offline: \{ title: copy\.offlineTitle, body: copy\.waitingBody \}/);
  const statePage = jsx.slice(
    jsx.indexOf('public-profile-page--state'),
    jsx.indexOf('const displayName = profile?.displayName'),
  );
  assert.match(statePage, /aria-busy=\{waiting\}/, 'a wait is announced as busy, an error is not');
  assert.match(statePage, /\{\(waiting \|\| status === 'error'\) && \(/,
    'Try again is offered in the three states, because pressing it is never wrong');
  assert.match(statePage, /setStatus\('loading'\);\s*setReloadToken/,
    'and pressing it brings the skeleton back before the new read starts');
});
