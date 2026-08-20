/**
 * User search (F9).
 *
 * `userProfiles/` and `handles/` have had `list: if false` since the F1
 * security review, and this phase does NOT reopen them: listing the profile
 * collection hands over the whole user directory, photos and bios included,
 * billed to this project. Firestore cannot do full-text search, but it does do
 * range queries, and that is enough for "find someone by their handle or their
 * name" against a separate, minimal collection.
 *
 * `userSearch/{uid}` holds exactly what a result row paints — handle and the
 * lowercased name — for accounts that chose to be public. A private profile has
 * no document here at all: "does not appear in results" is absence at the data
 * layer, enforced by rules from both sides, not a filter this file applies and
 * a modified client could skip.
 *
 * Two prefix queries per executed search, merged and deduplicated by uid here.
 * Each carries its own ceiling, and `firestore.rules` refuses any query on this
 * collection without one — so the bound is the server's, not this file's good
 * manners. Nothing here is imported by the feed: a feed load still costs one
 * read.
 */

import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  where,
} from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';

/** The collection, named once. `firestore.rules` matches the same segment. */
export const USER_SEARCH_COLLECTION = 'userSearch';

/**
 * Rows asked for per query. Two queries run per search, so a search costs at
 * most 20 reads and typically far fewer — Firestore bills a query by the
 * documents it returns, with a floor of one.
 */
export const USER_SEARCH_PAGE_SIZE = 10;

/**
 * The ceiling the rules impose on any single query (`request.query.limit <=
 * 20`, the follows/ pattern but stricter). Exported so a test can prove this
 * file stays under a bound the database also enforces.
 */
export const USER_SEARCH_LIMIT_CEILING = 20;

/**
 * Two characters, so a one-letter prefix cannot be used to walk the index a
 * page at a time from the app itself. It is friction, not a wall — the security
 * analysis (02-SECURITY.md §7) is explicit that any prefix-queryable index is
 * enumerable with patience, and about what that patience buys.
 */
export const USER_SEARCH_MIN_LENGTH = 2;

/**
 * Searches fire on submit, or after this quiet period — never per keystroke.
 * A per-keystroke search turns one lookup into one query per letter, on a free
 * tier whose daily read quota is the real backstop.
 */
export const USER_SEARCH_DEBOUNCE_MS = 400;

/** The last code point Firestore sorts, which turns a prefix into a range. */
const RANGE_END = '\uf8ff';

const HANDLE_MAX = 40;
const NAME_MAX = 80;

export class UserSearchUnsupportedError extends Error {
  constructor() {
    super('User search is unavailable in demo mode.');
    this.name = 'UserSearchUnsupportedError';
    this.code = 'USER_SEARCH_UNSUPPORTED_IN_DEMO';
  }
}

export class UserSearchAuthRequiredError extends Error {
  constructor() {
    super('Searching for people requires a session.');
    this.name = 'UserSearchAuthRequiredError';
    this.code = 'USER_SEARCH_AUTH_REQUIRED';
  }
}

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
export function toIndexedName(displayName) {
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
export function userSearchEntry({ handle, displayName }) {
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
export function userSearchReference(database, uid, document = doc) {
  return document(database, USER_SEARCH_COLLECTION, uid);
}

/**
 * What a caller typed, reduced to what can be sent as a prefix. Lowercased for
 * the same reason the stored fields are: the index holds one case, so the query
 * has to speak it.
 */
export function normalizeUserSearchTerm(value) {
  const term = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  // The same ASCII-only lowering the stored fields went through, or the query
  // would speak a case the index does not hold: "MUÑOZ" is stored as "muÑoz",
  // so a term lowered all the way to "muñoz" would match nothing.
  return toIndexedName(term.slice(0, NAME_MAX));
}

/** True when a term is worth spending two queries on. */
export function isSearchableTerm(value) {
  return normalizeUserSearchTerm(value).length >= USER_SEARCH_MIN_LENGTH;
}

/**
 * Merges the two result sets into one list.
 *
 * A handle hit and a name hit for the same account are one person, so the merge
 * is keyed by uid. Handle matches come first: typing "@nick" and getting the
 * account whose handle is exactly that, below three people whose names start
 * the same way, reads as a broken search.
 */
export function mergeUserSearchResults(handleMatches, nameMatches) {
  const merged = [];
  const seen = new Set();
  for (const row of [...(handleMatches || []), ...(nameMatches || [])]) {
    if (!row?.uid || seen.has(row.uid)) continue;
    seen.add(row.uid);
    merged.push(row);
  }
  return merged;
}

function readRow(snapshot) {
  const data = snapshot.data() || {};
  const handle = typeof data.handle === 'string' ? data.handle.slice(0, HANDLE_MAX) : '';
  const name = typeof data.nameLower === 'string' ? data.nameLower.slice(0, NAME_MAX) : '';
  return handle ? { uid: snapshot.id, handle, name } : null;
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    collection: overrides.collection || collection,
    getDocuments: overrides.getDocuments || getDocs,
    query: overrides.query || query,
  };
}

/** One bounded prefix query over one field. */
async function prefixMatches(api, field, term) {
  const snapshot = await api.getDocuments(api.query(
    api.collection(api.database, USER_SEARCH_COLLECTION),
    where(field, '>=', term),
    where(field, '<=', term + RANGE_END),
    limit(USER_SEARCH_PAGE_SIZE),
  ));
  return (snapshot?.docs || []).map(readRow).filter(Boolean);
}

/**
 * Finds public profiles whose handle or name starts with `term`.
 *
 * Prefix from the start of the field, which is what a range query can do:
 * "nico" finds "nicolás muñoz" and "@nick_mugar"; "muñoz" finds neither, and
 * there is no typo tolerance. The escalation that keeps the derivation
 * verifiable in rules (a `nameTokens` array) is written up in 02-SECURITY.md §7
 * — deliberately not an external search engine, which cannot be synchronised
 * from a client without exposing a write key.
 */
export async function searchUsers(term, overrides) {
  const api = operations(overrides);
  if (api.isDemo) throw new UserSearchUnsupportedError();
  // Rules require a session for `list` here. Failing before the round trip
  // makes that a stated rule rather than an opaque permission error.
  if (!api.currentUser?.uid) throw new UserSearchAuthRequiredError();

  const normalized = normalizeUserSearchTerm(term);
  // Below the minimum this costs nothing: no query is issued at all.
  if (normalized.length < USER_SEARCH_MIN_LENGTH) return [];

  const [handleMatches, nameMatches] = await Promise.all([
    prefixMatches(api, 'handle', normalized),
    prefixMatches(api, 'nameLower', normalized),
  ]);
  return mergeUserSearchResults(handleMatches, nameMatches);
}
