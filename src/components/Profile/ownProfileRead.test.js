import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The editor's own read, for finding C3 of
 * docs/AUDITORIA-COMENTARIOS-2026-09-05.md reached through its third door.
 *
 * A `getDoc` the local cache answers with "no such document" resolves in about
 * half a millisecond and never rejects, so the patience wrapped around it had
 * nothing to retry: this screen settled on "create your profile" for an
 * account that has one, and — because `ownProfileCache` is shared — told the
 * comments sheet the same thing.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

const profileEffect = jsx => jsx.match(
  /patientRead\(\(\) => readConfirmedOwnUserProfile\(\)[\s\S]*?controller\.abort\(\);/,
);

test('the editor reads its profile with authority, so a stall is retried instead of settled', async () => {
  const jsx = await read('./ProfilePage.jsx');
  assert.match(jsx, /readConfirmedOwnUserProfile,/, 'the confirmed sibling is imported');
  const effect = profileEffect(jsx);
  assert.ok(effect, 'the load still goes through patientRead and still aborts on cleanup');
  assert.match(effect[0], /onLateResult: applyProfile/,
    'an answer that lands after the budget still seats the form');
  assert.match(effect[0], /if \(isTransientReadError\(error\)\) \{/,
    "a spent budget is a wait with the loop still running, not the screen's failure");
  assert.equal((jsx.match(/readOwnUserProfile\(/g) || []).length, 1,
    'the one survivor is the re-read after a failed save, which drops a null instead of showing it '
    + '(`if (!fresh) return;`). The load path may not use it: it RESOLVES a cache-served miss.');
});

test('the wait for the profile has to have waited before it says so', async () => {
  const jsx = await read('./ProfilePage.jsx');
  assert.match(jsx, /import \{[\s\S]*?slowNoticeStatus[\s\S]*?\} from '\.\.\/\.\.\/utils\/boundedRead\.js';/);
  assert.match(jsx, /const startedAt = Date\.now\(\);/, 'the effect stamps when the read began');
  const effect = profileEffect(jsx)[0];
  const onSlow = effect.match(/onSlow: [\s\S]*?onLateResult:/);
  assert.ok(onSlow, 'onSlow still comes before onLateResult');
  assert.match(onSlow[0], /slowNoticeStatus\(Date\.now\(\) - startedAt, info\)/,
    'onSlow fires on every transient rejection, and an unconfirmed absence rejects in about half a '
    + 'millisecond: without the gate the whole "this is taking longer than usual" panel replaced the '
    + 'loading line inside the first frame.');
  assert.doesNotMatch(onSlow[0], /info\?\.offline \? 'offline' : 'slow'/,
    'the offline decision belongs to the gate now, which exempts it from the wait');
});

test('only a settled screen writes through to the shared profile cache', async () => {
  const jsx = await read('./ProfilePage.jsx');
  const writeThrough = jsx.match(
    /if \(!user\?\.uid[\s\S]{0,120}?\) return;\s*rememberOwnProfile\(user\.uid, profile\);/,
  );
  assert.ok(writeThrough, 'the write-through still watches the profile value rather than each edit');
  assert.match(writeThrough[0], /status !== 'ready' && status !== 'new'/,
    "'slow' and 'offline' are waits with `profile` still null, and this effect runs on every status "
    + 'change: an allow-list of the two settled answers is what keeps an unconfirmed absence out of '
    + 'the cache the comments sheet seeds its footer from.');
});
