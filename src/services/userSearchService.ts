import type { Firestore } from 'firebase/firestore';
/**
 * The people index, write side.
 *
 * `userSearch/{uid}` holds the handle and the lowercased name of an account
 * that chose to be public. A private profile has no document here at all,
 * enforced by rules from both sides. No search queries the index; it is still
 * written because `firestore.rules` checks every profile write against its
 * entry, so profile saves keep the two in step (`userProfileService.js`).
 */

import { doc } from 'firebase/firestore';

/** The collection, named once. `firestore.rules` matches the same segment. */
export const USER_SEARCH_COLLECTION = 'userSearch';

const HANDLE_MAX = 40;
const NAME_MAX = 80;

/**
 * The indexed form of a display name: ASCII-only lowercase.
 *
 * `firestore.rules` verifies `nameLower == displayName.lower()` on every write,
 * so this must agree with the rules engine exactly — and the rules engine's
 * `.lower()` is ASCII-only. Measured against the emulator, not assumed:
 * "Nicolás MUÑOZ" lowers to "nicolás muÑoz" there, keeping the Ñ. Using
 * JavaScript's `toLowerCase()` here would produce "muñoz", the equality would
 * fail, and an account with an accented capital in its name could not save its
 * profile at all. `tests/firestore.rules.test.js` pins the agreement by running
 * this very function against the deployed clauses.
 *
 * Nothing else happens here: no accent folding, no punctuation stripping, no
 * tokenising. Anything the rules cannot recompute from the real display name
 * reopens the hole this equality closes — a client writing "taylor swift" into
 * its own entry to surface in other people's searches.
 */
export function toIndexedName(displayName: unknown) {
  const value = typeof displayName === 'string' ? displayName : '';
  return value.slice(0, NAME_MAX).replace(/[A-Z]/g, letter => letter.toLowerCase());
}

/**
 * The document a public profile mirrors into the index: two fields, both
 * recomputable from the profile, and nothing else.
 *
 * There is deliberately no timestamp. The entry used to carry a `createdAt`
 * stamped with the server clock, which this function rewrote on every profile
 * save — a field named for creation that actually tracked the last edit, and
 * one that any signed-in caller could `orderBy` to get a listing of who touched
 * their profile most recently. Nothing ever read it.
 */
export function userSearchEntry({ handle, displayName }: { handle?: unknown; displayName?: unknown }) {
  const cleanHandle = typeof handle === 'string' ? handle.trim().toLowerCase() : '';
  const nameLower = toIndexedName(displayName);
  if (!cleanHandle || cleanHandle.length > HANDLE_MAX) {
    throw new TypeError('A handle is required to index a profile.');
  }
  // Emptiness is checked on the trimmed value, but the stored one is not
  // trimmed: it has to stay exactly `displayName.lower()` for the rules to
  // accept it. Profiles are written through `sanitizeUserProfile`, which trims,
  // so the two only ever differ for a name this throws on anyway.
  if (!nameLower.trim()) throw new TypeError('A display name is required to index a profile.');
  return { handle: cleanHandle, nameLower };
}

/** Where a uid's index entry lives. Keyed by uid, matching the profile. */
export function userSearchReference(database: Firestore, uid: string, document = doc) {
  return document(database, USER_SEARCH_COLLECTION, uid);
}
