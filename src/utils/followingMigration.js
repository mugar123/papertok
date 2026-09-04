import { arrayRemove, serverTimestamp } from 'firebase/firestore';

/**
 * The write that finishes the one-time legacy `followedAuthors` migration.
 *
 * A field transform, not the array: `followedAuthors: []` is a write of the
 * whole field. This app still has a name-only follow that writes straight to
 * that field (see followedAuthors.js) -- if it lands on the server while this
 * migration is still copying, a plain `[]` here would erase the name it just
 * added, and that name was never copied to `following` either, since it
 * did not exist yet when this migration read `followedAuthors`. Gone from
 * both places.
 *
 * `arrayRemove` applies to the value on the SERVER at write time, not to the
 * `followedAuthors` this session read, so a name a concurrent follow adds
 * survives regardless of write order. Only the names actually read (and so
 * already migrated -- copied by this run, or already present) are named for
 * removal, as individual values rather than the array itself. `undefined`/
 * `null` make `arrayRemove` throw, and the legacy array can carry either, so
 * blanks are dropped first.
 */
export function finishLegacyAuthorsMigration(followedAuthors, { remove = arrayRemove, timestamp = serverTimestamp } = {}) {
  const names = [...new Set(
    (followedAuthors || []).filter((name) => typeof name === 'string' && name.length > 0),
  )];
  return {
    followedAuthors: remove(...names),
    followingMigratedAt: timestamp(),
  };
}
