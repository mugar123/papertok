/**
 * Public user profiles (F1).
 *
 * `userProfiles/{uid}` is the public half of an account, deliberately separate
 * from the private `users/{uid}` document (which is owner-only and already
 * carries a 280 KB photo in the auth bootstrap). Reading a profile costs one
 * Firestore read because the pinned lists are denormalized into it.
 *
 * Handle uniqueness is a `handles/{handle}` reservation document written in the
 * same batch as the profile, exactly like `publicLists`/`publicListOwners`.
 * The rules make the reservation create-only, so two accounts racing for the
 * same handle cannot both win: the second create is rejected by the database,
 * not by a client-side check.
 *
 * Nothing here reads or writes `publicLists`/`publicListOwners`. Attribution is
 * opt-in: a list becomes attributable only because its owner pinned a copy of
 * its card into their own profile.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';
import { normalizeHandle, requireHandle } from '../utils/userHandle.js';

export const USER_PROFILE_LIMITS = Object.freeze({
  displayName: 80,
  bio: 500,
  photo: 60000,
  // Six, matching firestore.rules, where the ceiling is set by the
  // 1000-expression budget per rule evaluation rather than by taste: eight
  // pinned entries fail outright against the emulator, seven pass with no
  // headroom left.
  pinnedLists: 6,
  listTitle: 120,
  listEmoji: 40,
  // A public list holds at most 12 papers (PUBLIC_LIST_LIMITS.papers), so a
  // card claiming more is a card lying about a list it denormalizes.
  listPaperCount: 12,
  shareId: 32,
});

/**
 * The pin picker reads the owner's own lists. It is a bounded page, never the
 * whole collection: an account with thousands of lists must not turn opening
 * the profile editor into an unbounded read.
 */
export const PINNABLE_LISTS_PAGE_SIZE = 60;

/** Fields only the service identity may ever write (F6). */
const SERVICE_ONLY_FIELDS = Object.freeze(['orcid', 'verified']);

export class UserProfileUnsupportedError extends Error {
  constructor() {
    super('Public profiles are unavailable in demo mode.');
    this.name = 'UserProfileUnsupportedError';
    this.code = 'USER_PROFILES_UNSUPPORTED_IN_DEMO';
  }
}

export class HandleUnavailableError extends Error {
  constructor(handle) {
    super(`The handle "${handle}" is already taken.`);
    this.name = 'HandleUnavailableError';
    this.code = 'HANDLE_UNAVAILABLE';
    this.handle = handle;
  }
}

function cleanString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function cleanMultilineString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\r\n?/g, '\n').slice(0, maximum);
}

function cleanPhoto(value) {
  if (typeof value !== 'string') return '';
  const photo = value.trim();
  // Only the recompressed data URL produced by utils/profileImage.js belongs
  // in the public document; anything else is dropped rather than truncated.
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return '';
  return photo.length <= USER_PROFILE_LIMITS.photo ? photo : '';
}

export function sanitizePinnedList(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const shareId = cleanString(entry.shareId || entry.publicShareId, 64).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(shareId)) return null;
  const title = cleanString(entry.title || entry.name, USER_PROFILE_LIMITS.listTitle);
  if (!title) return null;
  const emoji = cleanString(entry.emoji, USER_PROFILE_LIMITS.listEmoji);
  const rawCount = Number.isInteger(entry.paperCount)
    ? entry.paperCount
    : (Array.isArray(entry.paperIds) ? entry.paperIds.length : 0);
  const paperCount = Number.isInteger(rawCount) && rawCount >= 0
    ? Math.min(rawCount, USER_PROFILE_LIMITS.listPaperCount)
    : 0;

  return { shareId, title, ...(emoji ? { emoji } : {}), paperCount };
}

export function sanitizePinnedLists(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const pinned = sanitizePinnedList(entry);
    if (!pinned || seen.has(pinned.shareId)) continue;
    seen.add(pinned.shareId);
    result.push(pinned);
    if (result.length >= USER_PROFILE_LIMITS.pinnedLists) break;
  }
  return result;
}

/** Pure: the pinned array a profile should hold after pinning `entry`. */
export function pinListEntry(currentPinned, entry) {
  const pinned = sanitizePinnedList(entry);
  if (!pinned) throw new TypeError('A published list is required to pin it.');
  const rest = sanitizePinnedLists(currentPinned).filter(item => item.shareId !== pinned.shareId);
  if (rest.length >= USER_PROFILE_LIMITS.pinnedLists) {
    throw new RangeError(`A profile holds at most ${USER_PROFILE_LIMITS.pinnedLists} pinned lists.`);
  }
  return [...rest, pinned];
}

/** Pure: the pinned array a profile should hold after unpinning `shareId`. */
export function unpinListEntry(currentPinned, shareId) {
  const normalized = cleanString(shareId, 64).toLowerCase();
  return sanitizePinnedLists(currentPinned).filter(item => item.shareId !== normalized);
}

/**
 * Splits a profile's pins into the ones still backed by a published list and
 * the ones whose list has since been unpublished.
 *
 * This matters because `firestore.rules` now refuses any profile write that
 * keeps a pin the caller does not own, and an unpublished list deletes the
 * `publicListOwners` document the check reads. The escape is to drop the stale
 * entry: rules validate the array being written, so an entry that is on its way
 * out is never checked. The profile screen surfaces this instead of letting the
 * save fail with a bare permission error.
 */
export function partitionStalePins(pinnedLists, publishedLists) {
  const live = new Set(
    (Array.isArray(publishedLists) ? publishedLists : [])
      .map(list => sanitizePinnedList(list)?.shareId)
      .filter(Boolean),
  );
  const pins = sanitizePinnedLists(pinnedLists);
  return {
    pinned: pins.filter(pin => live.has(pin.shareId)),
    stale: pins.filter(pin => !live.has(pin.shareId)),
  };
}

/**
 * Builds the client-writable half of a profile. `orcid` and `verified` are
 * absent by construction: this allowlist is what keeps a user from marking
 * themselves verified even before the rules get a say.
 */
export function sanitizeUserProfile(input) {
  const displayName = cleanString(input?.displayName, USER_PROFILE_LIMITS.displayName);
  if (!displayName) throw new TypeError('A display name is required.');
  const bio = cleanMultilineString(input?.bio, USER_PROFILE_LIMITS.bio);
  const photo = cleanPhoto(input?.photo);

  return {
    displayName,
    ...(bio ? { bio } : {}),
    ...(photo ? { photo } : {}),
    allowContact: input?.allowContact === true,
    pinnedLists: sanitizePinnedLists(input?.pinnedLists),
  };
}

/**
 * `orderBy('publicShareId')` is doing real work here: Firestore drops
 * documents that lack the ordered field, so this returns published lists only,
 * with no extra index and no client-side scan of every list the user owns.
 */
async function defaultPublishedLists(database, uid, pageSize) {
  const snapshot = await getDocs(query(
    collection(database, 'users', uid, 'lists'),
    orderBy('publicShareId'),
    limit(pageSize),
  ));
  return snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    publishedLists: overrides.publishedLists || defaultPublishedLists,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    batch: overrides.batch || (database => writeBatch(database)),
    document: overrides.document || doc,
    getDocument: overrides.getDocument || getDoc,
    now: overrides.now || serverTimestamp,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new UserProfileUnsupportedError();
}

function requireOwner(api) {
  const uid = cleanString(api.currentUser?.uid, 128);
  if (!uid) throw new Error('Authentication is required to manage a public profile.');
  return uid;
}

function profileReference(api, uid) {
  return api.document(api.database, 'userProfiles', uid);
}

function handleReference(api, handle) {
  return api.document(api.database, 'handles', handle);
}

/**
 * A rejected reservation is indistinguishable from any other denied write at
 * the SDK level, so a batch that claims a handle reports the collision the way
 * the UI needs to hear it.
 */
async function commitHandleClaim(batch, handle) {
  try {
    await batch.commit();
  } catch (error) {
    if (error?.code === 'permission-denied') throw new HandleUnavailableError(handle);
    throw error;
  }
}

export async function createUserProfile(input, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const handle = requireHandle(input?.handle);
  const payload = sanitizeUserProfile(input);
  const timestamp = api.now();
  const batch = api.batch(api.database);

  batch.set(profileReference(api, uid), {
    handle,
    ...payload,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(handleReference(api, handle), { uid, createdAt: timestamp });
  await commitHandleClaim(batch, handle);
  return { uid, handle, ...payload };
}

export async function updateUserProfile(patch, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const payload = sanitizeUserProfile(patch);
  const batch = api.batch(api.database);

  batch.update(profileReference(api, uid), { ...payload, updatedAt: api.now() });
  await batch.commit();
  return { uid, ...payload };
}

/**
 * Pinning writes one document: the owner's profile. `publicLists` and
 * `publicListOwners` are never opened, let alone modified.
 */
export async function savePinnedLists(pinnedLists, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const payload = sanitizePinnedLists(pinnedLists);
  const batch = api.batch(api.database);

  batch.update(profileReference(api, uid), { pinnedLists: payload, updatedAt: api.now() });
  await batch.commit();
  return payload;
}

/**
 * Delete the old reservation, create the new one and repoint the profile in a
 * single batch. The rules refuse the update unless both halves are present, so
 * an account can never hold two handles or abandon one it still advertises.
 */
export async function changeUserHandle(nextHandle, currentHandle, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const handle = requireHandle(nextHandle);
  const previous = normalizeHandle(currentHandle);
  if (!previous) throw new TypeError('The current handle is required to change it.');
  if (previous === handle) return { uid, handle, changed: false };

  const timestamp = api.now();
  const batch = api.batch(api.database);

  batch.delete(handleReference(api, previous));
  batch.set(handleReference(api, handle), { uid, createdAt: timestamp });
  batch.update(profileReference(api, uid), { handle, updatedAt: timestamp });
  await commitHandleClaim(batch, handle);
  return { uid, handle, changed: true };
}

function readProfileSnapshot(snapshot) {
  if (!snapshot?.exists()) return null;
  const data = snapshot.data() || {};
  return {
    uid: snapshot.id,
    ...data,
    pinnedLists: sanitizePinnedLists(data.pinnedLists),
  };
}

/** One read. */
export async function readUserProfile(uid, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const normalized = cleanString(uid, 128);
  if (!normalized) return null;
  const snapshot = await api.getDocument(profileReference(api, normalized));
  return readProfileSnapshot(snapshot);
}

/** Two reads: the handle reservation, then the profile it points at. */
export async function readUserProfileByHandle(handle, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const normalized = normalizeHandle(handle);
  if (!normalized) return null;

  const reservation = await api.getDocument(handleReference(api, normalized));
  if (!reservation?.exists()) return null;
  const uid = cleanString(reservation.data()?.uid, 128);
  if (!uid) return null;

  const snapshot = await api.getDocument(profileReference(api, uid));
  const profile = readProfileSnapshot(snapshot);
  // A reservation whose profile moved on is stale, not a redirect.
  return profile && normalizeHandle(profile.handle) === normalized ? profile : null;
}

/**
 * The published lists this account could pin, as pinnable cards. Reads the
 * owner's private list documents; `publicLists` is not opened.
 */
export async function readPinnableLists(overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const lists = await api.publishedLists(api.database, uid, PINNABLE_LISTS_PAGE_SIZE);

  return (Array.isArray(lists) ? lists : [])
    .slice(0, PINNABLE_LISTS_PAGE_SIZE)
    .map(list => sanitizePinnedList({
      shareId: list?.publicShareId,
      title: list?.name || list?.title,
      emoji: list?.emoji,
      paperCount: Array.isArray(list?.paperIds) ? list.paperIds.length : list?.paperCount,
    }))
    .filter(Boolean);
}

export async function readOwnUserProfile(overrides) {
  const api = operations(overrides);
  requireSupported(api);
  return readUserProfile(requireOwner(api), overrides);
}

export { SERVICE_ONLY_FIELDS };
