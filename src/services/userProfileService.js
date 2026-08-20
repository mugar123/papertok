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
  deleteField,
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
import { PUBLIC_LIST_LIMITS } from './publicListPayload.js';
import { userSearchEntry, userSearchReference } from './userSearchService.js';
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
  // The pin card mirrors the public list it denormalizes, so its count is
  // capped by the same limit that caps the list itself. Imported rather than
  // repeated: this sat at a literal 12 while F11 raised the list cap to 50,
  // and every card for a bigger list quietly lied ("12 papers" on a list of
  // 19). firestore.rules carries the same number in `entry.paperCount <=`;
  // a test holds the two together.
  listPaperCount: PUBLIC_LIST_LIMITS.papers,
  shareId: 32,
});

/**
 * The ceiling for every screen that reads an account's own `lists` collection.
 * A bounded page, never the whole collection: an account with thousands of
 * lists must not turn opening a screen into an unbounded read.
 *
 * The pin picker was the only reader that honoured this. The save-and-organize
 * modal and the lists page both read `collection(users/{uid}/lists)` raw — the
 * only two unbounded collection reads left in the client — so they take the
 * same ceiling from here rather than inventing their own.
 */
export const OWN_LISTS_PAGE_SIZE = 60;

/** The pin picker's name for the same ceiling. */
export const PINNABLE_LISTS_PAGE_SIZE = OWN_LISTS_PAGE_SIZE;

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

/**
 * Avatar hosts whose URLs may be stored verbatim in the public profile.
 *
 * Google serves account avatars — including the generated letter ones — from
 * these, and refuses CORS on them, so the browser cannot fetch and recompress
 * one into a data URL: the URL itself is the only way to show it. Keeping this
 * to an allowlist stops the public profile from becoming an embed for an
 * arbitrary URL, which would let a profile owner log the IP of everyone who
 * views their page.
 */
const AVATAR_URL_ALLOWLIST = /^https:\/\/lh[3-6]\.googleusercontent\.com\/[^\s"'<>]+$/;

function cleanPhoto(value) {
  if (typeof value !== 'string') return '';
  const photo = value.trim();
  if (photo.length > USER_PROFILE_LIMITS.photo) return '';
  // Either a recompressed data URL from utils/profileImage.js, or an avatar
  // URL from a host on the allowlist. Anything else is dropped, not truncated.
  const isInlineImage = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo);
  return isInlineImage || AVATAR_URL_ALLOWLIST.test(photo) ? photo : '';
}

/**
 * The avatar the public profile should mirror, given the two the app already
 * has: the private uploaded one and the identity provider's.
 *
 * The uploaded photo wins, but only if it fits the public budget — the private
 * copy may be up to 280 KB, far past what belongs in a document read on every
 * profile visit. Callers holding the original file should recompress with
 * PUBLIC_AVATAR_PRESET instead of relying on this fallback.
 */
export function publicAvatarFrom(uploadedPhoto, providerPhotoUrl) {
  return cleanPhoto(uploadedPhoto) || cleanPhoto(providerPhotoUrl) || '';
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
 * Pure: the pinned array after toggling `card`, with every pin that is no
 * longer backed by a published list dropped on the way.
 *
 * The rules ownership-check every entry in the array being written, and a
 * stale pin — its list unpublished, or republished under a fresh share id —
 * fails that check, so one leftover entry vetoes the WHOLE write, including
 * the attempt to pin the list's own successor. That is exactly the state a
 * republish produces, and what the profile screen surfaced as a bare
 * "something went wrong" on the Pin button.
 *
 * `publishedLists` is the pin picker's own data (readPinnableLists), so the
 * filter costs no extra read. It must have actually loaded: dropping every
 * pin because the picker has not answered yet would be the worse bug, so a
 * missing list refuses instead of guessing.
 */
export function togglePinnedList(currentPinned, card, publishedLists) {
  if (!Array.isArray(publishedLists)) {
    throw new TypeError('The published lists are required to toggle a pin.');
  }
  const { pinned } = partitionStalePins(currentPinned, publishedLists);
  const target = sanitizePinnedList(card);
  if (!target) throw new TypeError('A published list is required to pin it.');
  return pinned.some(item => item.shareId === target.shareId)
    ? unpinListEntry(pinned, target.shareId)
    : pinListEntry(pinned, target);
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
 * Profile visibility (F8).
 *
 * A string with no default anywhere in this module, deliberately. The absence
 * of the field means "written before this phase", which reads as public — so a
 * default here would be indistinguishable from a real choice, and the whole
 * point is that the first choice is made by the user rather than inherited.
 */
export const PROFILE_VISIBILITY = Object.freeze({ public: 'public', private: 'private' });

export function isVisibilityChoice(value) {
  return value === PROFILE_VISIBILITY.public || value === PROFILE_VISIBILITY.private;
}

/** A profile document with no `visibility` predates F8 and is public. */
export function profileIsPublic(profile) {
  return profile?.visibility !== PROFILE_VISIBILITY.private;
}

/** True when the owner has never made the choice, so the app must ask. */
export function needsVisibilityChoice(profile) {
  return Boolean(profile) && !isVisibilityChoice(profile.visibility);
}

export function pinnedListsAreVisible(profile) {
  return profile?.showPinnedLists !== false;
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

/**
 * Every list the account owns, published or not. Same bounded-page rule as
 * `defaultPublishedLists`; no `orderBy`, because ordering on a field would
 * silently drop the documents that lack it, and here every list must appear.
 */
async function defaultOwnLists(database, uid, pageSize) {
  const snapshot = await getDocs(query(
    collection(database, 'users', uid, 'lists'),
    limit(pageSize),
  ));
  return snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    publishedLists: overrides.publishedLists || defaultPublishedLists,
    ownLists: overrides.ownLists || defaultOwnLists,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    batch: overrides.batch || (database => writeBatch(database)),
    deleteValue: overrides.deleteValue || deleteField,
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

function searchReference(api, uid) {
  return userSearchReference(api.database, uid, api.document);
}

/**
 * Keeps the search index (F9) in step with the profile, inside the caller's
 * batch: a profile that is EXPLICITLY public after the write has an entry, and
 * anything else has none.
 *
 * `firestore.rules` refuses any other outcome — a write that leaves the profile
 * private while an entry survives is denied, and so is one that renames out from
 * under an entry still serving the old name — so this is not a courtesy the
 * client extends, it is the shape the database accepts.
 *
 * "Explicitly" is the part that is easy to get wrong. A profile written before
 * F8 has no `visibility` field and reads as public everywhere else, because its
 * page always was public. Being listed in a searchable index is a different
 * question, and that account was never asked it: the one-time prompt F8 shows
 * is where the answer comes from, and until it arrives the account stays out.
 * The rules enforce the same thing, so this is not a filter a modified client
 * could skip — but doing it here too means such an account is never denied a
 * save for attempting a write the rules were going to refuse.
 *
 * The delete branch is a no-op when there is nothing to delete, and it is what
 * keeps the switch usable in both directions — and what lets an account that
 * was indexed before the choice existed leave the index on its next save.
 */
function syncSearchEntry(api, batch, uid, { handle, displayName, visibility }) {
  const reference = searchReference(api, uid);
  if (visibility !== PROFILE_VISIBILITY.public) {
    batch.delete(reference);
    return;
  }
  batch.set(reference, userSearchEntry({ handle, displayName }));
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
  // No fallback on purpose: a profile cannot come into existence without its
  // owner having chosen. The second rules deploy makes this a server-side
  // invariant too; refusing here means the UI can never skip the question by
  // accident.
  if (!isVisibilityChoice(input?.visibility)) {
    throw new TypeError('A visibility choice is required to create a profile.');
  }
  const timestamp = api.now();
  const batch = api.batch(api.database);

  batch.set(profileReference(api, uid), {
    handle,
    ...payload,
    visibility: input.visibility,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.set(handleReference(api, handle), { uid, createdAt: timestamp });
  syncSearchEntry(api, batch, uid, {
    handle,
    displayName: payload.displayName,
    visibility: input.visibility,
  });
  await commitHandleClaim(batch, handle);
  return { uid, handle, ...payload, visibility: input.visibility };
}

/**
 * Flips the profile between public and private. One field on one document:
 * the handle reservation is deliberately left alone, so going private is
 * reversible — freeing the handle would let somebody take it while you are
 * away, and a switch you cannot switch back is not a switch.
 */
export async function saveProfileVisibility(visibility, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  if (!isVisibilityChoice(visibility)) {
    throw new TypeError('Visibility must be either public or private.');
  }
  // One read, on a deliberate privacy action: the entry has to carry the
  // handle and name the profile really holds, and the rules check that against
  // the post-batch profile. Trusting a value the caller passed in would write a
  // stale entry on the way out of privacy, or fail the write outright.
  const current = await api.getDocument(profileReference(api, uid));
  const profile = current?.data?.() || {};
  const batch = api.batch(api.database);
  batch.update(profileReference(api, uid), { visibility, updatedAt: api.now() });
  syncSearchEntry(api, batch, uid, {
    handle: profile.handle,
    displayName: profile.displayName,
    visibility,
  });
  await batch.commit();
  return { uid, visibility };
}

/**
 * Where hidden pins wait. A document in an owner-only subcollection rather
 * than a field on `users/{uid}`: accounts created by early versions of the app
 * carry fields that document's key allowlist does not cover, so every merge
 * write to it is denied. That is a pre-existing bug with its own fix; parking
 * the pins somewhere else keeps this feature from depending on it.
 */
function stashReference(api, uid) {
  return api.document(api.database, 'users', uid, 'profileStash', 'pinnedLists');
}

/**
 * Shows or hides the pinned lists.
 *
 * Firestore has no field-level security: every field of a readable document is
 * readable. So hiding the pins cannot be a flag the UI honours — the entries
 * have to leave the public document. They are parked in `users/{uid}`, which
 * is owner-only, and put back verbatim when the switch goes the other way.
 * Two documents, one batch, so the pins can never exist in both places or in
 * neither.
 */
export async function setPinnedListsVisible(visible, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const batch = api.batch(api.database);
  const profileRef = profileReference(api, uid);
  const stashRef = stashReference(api, uid);

  if (visible) {
    // Restoring reads the stash — one bounded document, and only on the click
    // that needs it, never on a page load.
    const stashed = await api.getDocument(stashRef);
    const pins = sanitizePinnedLists(stashed?.data?.()?.pinnedLists);
    batch.update(profileRef, {
      pinnedLists: pins,
      showPinnedLists: true,
      updatedAt: api.now(),
    });
    batch.set(stashRef, { pinnedLists: [], updatedAt: api.now() });
    await batch.commit();
    return { uid, showPinnedLists: true, pinnedLists: pins };
  }

  const current = await api.getDocument(profileRef);
  const pins = sanitizePinnedLists(current?.data?.()?.pinnedLists);
  batch.set(stashRef, { pinnedLists: pins, updatedAt: api.now() });
  batch.update(profileRef, {
    pinnedLists: [],
    showPinnedLists: false,
    updatedAt: api.now(),
  });
  await batch.commit();
  return { uid, showPinnedLists: false, pinnedLists: [] };
}

export async function updateUserProfile(patch, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const payload = sanitizeUserProfile(patch);
  // Read rather than trust the caller: this runs immediately after
  // `changeUserHandle` in the editor's save, so the handle in hand may be one
  // commit out of date, and the index entry must agree with the stored profile
  // or the rules refuse it.
  const current = await api.getDocument(profileReference(api, uid));
  const profile = current?.data?.() || {};
  const batch = api.batch(api.database);

  batch.update(profileReference(api, uid), { ...payload, updatedAt: api.now() });
  if (profile.handle) {
    syncSearchEntry(api, batch, uid, {
      handle: profile.handle,
      displayName: payload.displayName,
      visibility: profile.visibility,
    });
  }
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
 * Mirrors the app avatar into the public profile. One document, one field.
 *
 * The private `users/{uid}.profilePhoto` is owner-only, so a signed-out visitor
 * can never see it; the public profile needs its own copy or it has no avatar
 * at all. Silently does nothing when there is no public profile yet — changing
 * a photo should not create one.
 */
export async function savePublicProfilePhoto(photo, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const existing = await api.getDocument(profileReference(api, uid));
  if (!existing?.exists()) return null;

  const value = cleanPhoto(photo);
  const batch = api.batch(api.database);
  batch.update(profileReference(api, uid), {
    photo: value || api.deleteValue(),
    updatedAt: api.now(),
  });
  await batch.commit();
  return value;
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

  const current = await api.getDocument(profileReference(api, uid));
  const profile = current?.data?.() || {};
  const timestamp = api.now();
  const batch = api.batch(api.database);

  batch.delete(handleReference(api, previous));
  batch.set(handleReference(api, handle), { uid, createdAt: timestamp });
  batch.update(profileReference(api, uid), { handle, updatedAt: timestamp });
  // The index is keyed by uid precisely so a rename is an update in place here
  // rather than a fourth document changing hands in this batch.
  syncSearchEntry(api, batch, uid, {
    handle,
    displayName: profile.displayName,
    visibility: profile.visibility,
  });
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

  // A private profile denies this read, and that denial must look exactly like
  // a handle nobody registered. Letting it surface as an error would make the
  // page say "could not load" for private profiles and "not available" for
  // free handles, which is a two-state oracle the rules were written to avoid.
  // The owner reading their own private profile is allowed, so this only
  // swallows denials for people who genuinely may not see it.
  let snapshot;
  try {
    snapshot = await api.getDocument(profileReference(api, uid));
  } catch (error) {
    if (error?.code === 'permission-denied') return null;
    throw error;
  }
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

/**
 * Unpublishes the public profile: deletes `userProfiles/{uid}` and its
 * `handles/{handle}` reservation in one batch — the rules refuse the profile
 * delete unless the reservation dies with it (hardening C in STATE.md), so
 * the pairing is not a courtesy, it is the only shape the database accepts.
 *
 * Everything else stays exactly as it was: published lists remain published
 * (they go back to being anonymous, which is the F1 attribution model), and
 * the private account is untouched. The handle becomes free for anyone,
 * including its previous owner.
 */
export async function deleteOwnUserProfile(overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const snapshot = await api.getDocument(profileReference(api, uid));
  if (!snapshot?.exists()) return false;

  const handle = normalizeHandle(snapshot.data()?.handle);
  const batch = api.batch(api.database);
  batch.delete(profileReference(api, uid));
  if (handle) batch.delete(handleReference(api, handle));
  // Unconditional, like the reservation: the rules refuse the profile delete
  // while a search entry survives it, so an unpublished profile can never be
  // left behind as a searchable name.
  batch.delete(searchReference(api, uid));
  await batch.commit();
  return true;
}

/**
 * Coerces whatever a list document carries as `createdAt` — a Firestore
 * Timestamp, an ISO string, a number, or nothing — into epoch millis, for
 * client-side ordering only. Never stored.
 */
function createdAtMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Every list the account owns, as cards for the owner's own profile page —
 * private ones included, which is why this must never feed a public surface.
 * The visitor-facing counterpart is the `pinnedLists` array already
 * denormalized into `userProfiles/{uid}`; nothing here is written anywhere.
 *
 * One bounded page, newest first, ordered on the client so a list without
 * `createdAt` still shows up.
 */
export async function readOwnLists(overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireOwner(api);
  const lists = await api.ownLists(api.database, uid, PINNABLE_LISTS_PAGE_SIZE);

  return (Array.isArray(lists) ? lists : [])
    .slice(0, PINNABLE_LISTS_PAGE_SIZE)
    .map(list => ({
      id: cleanString(list?.id, 128),
      title: cleanString(list?.name || list?.title, USER_PROFILE_LIMITS.listTitle),
      emoji: cleanString(list?.emoji, USER_PROFILE_LIMITS.listEmoji),
      paperCount: Array.isArray(list?.paperIds) ? list.paperIds.length : 0,
      isPublished: Boolean(cleanString(list?.publicShareId, USER_PROFILE_LIMITS.shareId)),
      createdAtMillis: createdAtMillis(list?.createdAt),
    }))
    .filter(entry => entry.id && entry.title)
    .sort((first, second) => (second.createdAtMillis - first.createdAtMillis)
      || first.title.localeCompare(second.title));
}

export { SERVICE_ONLY_FIELDS };
