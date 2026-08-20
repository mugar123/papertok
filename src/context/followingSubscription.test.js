import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Structural guards on the one Firestore listener the app has.
 *
 * There is no React renderer under `node --test` here, so these read the source
 * — the same technique `userProfileService.test.js` uses on the rules file. They
 * catch a dependency being added back, which is exactly how this regressed:
 * nothing about it is visible in behaviour, it just costs a teardown and a full
 * re-read of `users/{uid}/following` every time it happens.
 */

const SOURCE = new URL('./FollowingContext.jsx', import.meta.url);

function subscriptionEffect(source) {
  // The effect that opens the snapshot listener, up to its dependency array.
  const start = source.indexOf('const followsCollection = collection(db');
  assert.ok(start > 0, 'could not find the follows subscription');
  const end = source.indexOf('}, [', start);
  assert.ok(end > start, 'could not find the end of the subscription effect');
  return source.slice(start, source.indexOf('\n', end));
}

test('the follows listener is keyed on the account and nothing else', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const effect = subscriptionEffect(source);
  const deps = effect.slice(effect.lastIndexOf('}, [')).match(/\}, \[([^\]]*)\]/)[1];

  assert.equal(
    deps.trim(),
    'user?.uid',
    'AuthContext replaces `followedAuthors` with a fresh array twice per sign-in '
    + '(once from cache, once from the server). As a dependency it tore down and '
    + 'rebuilt the only Firestore listener in the app at least twice per sign-in.',
  );
});

test('the subscription reads the legacy authors through the ref, not the closure', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const effect = subscriptionEffect(source);

  assert.ok(
    !/migrateLegacyAuthors\(followedAuthors\)/.test(effect),
    'reading `followedAuthors` directly here would put it back in the dependencies',
  );
  assert.ok(
    effect.includes('followedAuthorsRef.current'),
    'the error path still needs the legacy authors; it takes them from the ref',
  );
});

test('the first-snapshot grace period raises an error instead of reporting an empty account', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const timeout = source.slice(
    source.indexOf('const loadingTimeout = window.setTimeout'),
    source.indexOf('const unsubscribe = onSnapshot'),
  );

  assert.ok(timeout.includes('setLoading(false)'), 'it must still unblock the feed');
  assert.ok(
    timeout.includes('FollowsUnavailableError'),
    'and it must say the list is unknown. Clearing `loading` alone rendered an '
    + 'account that follows people as an account that follows nobody.',
  );
});

test('a real snapshot clears the grace-period error', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const callback = source.slice(
    source.indexOf('const unsubscribe = onSnapshot'),
    source.indexOf('}, (snapshotError) =>'),
  );

  assert.ok(
    callback.includes('setError(null)'),
    'otherwise the sheet stays in an error state the server has already answered',
  );
});

test('the migration waits for a snapshot before writing anything', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const migration = source.slice(source.indexOf('One-off migration of the pre-'));

  assert.ok(
    migration.includes('!followsArrived.current'),
    'migrating against the empty placeholder would re-create follows the user removed',
  );
  assert.ok(
    migration.includes('legacyMigrationAttempted.current'),
    'and it must still run at most once',
  );
});
