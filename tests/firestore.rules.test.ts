/**
 * Behavioural tests for `firestore.rules`, executed against the Firestore emulator.
 *
 * These exist because the tests under `src/` that read `firestore.rules` as text
 * catch a clause being deleted, but they cannot catch a clause that was never
 * written. Everything here performs a real request and asserts on what the
 * rules engine actually decides.
 *
 * Run with `npm run test:rules`, which starts the emulator around this file.
 * The emulator needs a JRE; without one the suite skips loudly rather than
 * passing vacuously.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { buildSavedPaperPayload } from '../src/utils/saved-paper-payload.ts';
import { paperLegacyAdapter, storedClassification } from '../src/models/paper.ts';
import { areaLabelForPaper } from '../src/utils/area-accent.ts';
import { serializeLibraryPaper } from '../src/utils/reading-library.ts';
import { LIST_COLORS } from '../src/utils/list-colors.ts';
import { USER_PREFERENCES_MAX } from '../src/utils/account-onboarding.ts';
import { buildSummaryHistoryQuery, buildSummaryWrite, SUMMARY_HISTORY_PAGE_SIZE } from '../src/services/saved-summary-service.ts';
import {
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  collection,
  collectionGroup,
  limit,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const ALICE_SHARE = 'a'.repeat(32);
const BOB_SHARE = 'b'.repeat(32);
const GHOST_SHARE = 'deadbeefdeadbeefdeadbeefdeadbeef';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST is unset — run these through `npm run test:rules`, '
    + 'which starts the emulator. Running them bare would report a pass without '
    + 'evaluating a single rule.',
  );
}

// PAPERTOK_RULES_PATH lets the mutation pass point this suite at a deliberately
// broken copy of the rules; unset, it is the file that ships.
const RULES_PATH = process.env.PAPERTOK_RULES_PATH
  ? new URL(`file://${process.env.PAPERTOK_RULES_PATH}`)
  : new URL('../firestore.rules', import.meta.url);

const testEnv = await initializeTestEnvironment({
  projectId: 'papertok-rules-test',
  firestore: {
    rules: await readFile(RULES_PATH, 'utf8'),
    host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0],
    port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),
  },
});

test.after(() => testEnv.cleanup());

/** Seeds documents with rules switched off, then hands back clean contexts. */
async function reset() {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // Two published lists, one owned by each user.
    await setDoc(doc(db, 'publicListOwners', ALICE_SHARE), { ownerId: ALICE, listId: 'l1', createdAt: new Date() });
    await setDoc(doc(db, 'publicListOwners', BOB_SHARE), { ownerId: BOB, listId: 'l2', createdAt: new Date() });
  });
}

const asAlice = () => testEnv.authenticatedContext(ALICE).firestore();
const asBob = () => testEnv.authenticatedContext(BOB).firestore();
const asGuest = () => testEnv.unauthenticatedContext().firestore();

// =========================================================================
// Reading
// =========================================================================

test('the private user tree stays private', async () => {
  await reset();
  await assertFails(getDoc(doc(asGuest(), 'users', ALICE)));
  await assertFails(getDoc(doc(asBob(), 'users', ALICE)));
});

// =========================================================================
// Comments, paper stubs, reports and the moderation switch are closed. The app
// no longer has comments; what earlier versions wrote is left to the Worker's
// service account, which account deletion uses to delete a user's comments
// and the reports that name them, and which the rules do not govern.
// =========================================================================

const DAVE = 'dave-uid'; // signed in, never created a profile
// The uid isAdmin() named before the rules dropped the admin role. It is a
// literal because the rules no longer contain it; the closure tests sign in
// as it to show that the old admin powers are gone.
const ADMIN = 'SrqikE0wbtPOsTZMnvK4lcLVHhD3';
const asDave = () => testEnv.authenticatedContext(DAVE).firestore();
const asAdmin = () => testEnv.authenticatedContext(ADMIN).firestore();

test('comments, paper stubs, reports and the moderation switch are closed to every client', async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'papers/k-doi-abc'), { canonicalKey: 'doi:10.1/abc', title: 'A paper', createdBy: DAVE });
    await setDoc(doc(db, 'papers/k-doi-abc/comments/c1'), {
      authorUid: DAVE, text: 'Written before comments went', status: 'visible',
    });
    await setDoc(doc(db, 'reports/r1'), { reporterUid: DAVE, status: 'open' });
    await setDoc(doc(db, 'config/moderation'), { commentsFrozen: false });
  });

  // Every read below was open to its caller before this section closed.
  for (const db of [asDave(), asAdmin(), asGuest()]) {
    await assertFails(getDoc(doc(db, 'papers/k-doi-abc')));
    await assertFails(getDoc(doc(db, 'papers/k-doi-abc/comments/c1')));
    await assertFails(getDocs(query(collectionGroup(db, 'comments'), where('authorUid', '==', DAVE), limit(5))));
    await assertFails(getDoc(doc(db, 'config/moderation')));
  }
  await assertFails(getDoc(doc(asAdmin(), 'reports/r1')));

  // And so was every write: the admin's moderation, the author's own edits.
  await assertFails(updateDoc(doc(asAdmin(), 'papers/k-doi-abc'), { title: 'Edited' }));
  await assertFails(updateDoc(doc(asDave(), 'papers/k-doi-abc/comments/c1'), {
    text: 'Edited', editedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(asAdmin(), 'papers/k-doi-abc/comments/c1'), { status: 'hidden' }));
  await assertFails(deleteDoc(doc(asDave(), 'papers/k-doi-abc/comments/c1')));
  await assertFails(deleteDoc(doc(asAdmin(), 'papers/k-doi-abc')));
  await assertFails(setDoc(doc(asAdmin(), 'config/moderation'), { commentsFrozen: true }));
});

// =========================================================================
// The people follow graph and the user search index are closed. The app no
// longer follows or searches for people; account deletion still removes the
// edges and the entry an account left behind, through the Worker's service
// account, which the rules do not govern.
// =========================================================================

test('the people follow graph and the user search index are closed to every client', async () => {
  const edge = `${BOB}_${ALICE}`;
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // Explicitly public profiles: what once made an account followable and
    // indexable, so every refusal below comes from the closure itself.
    for (const [uid, handle] of [[ALICE, 'alice'], [BOB, 'bob']]) {
      await setDoc(doc(db, 'userProfiles', uid), {
        handle, displayName: handle, pinnedLists: [], visibility: 'public',
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
    await setDoc(doc(db, 'follows', edge), { followerUid: BOB, targetUid: ALICE, createdAt: new Date() });
    await setDoc(doc(db, 'userSearch', ALICE), { handle: 'alice', nameLower: 'alice' });
  });

  // Every read below was open to its caller before this section closed.
  for (const db of [asGuest(), asAlice(), asBob()]) {
    await assertFails(getDoc(doc(db, 'follows', edge)));
    await assertFails(getDocs(query(collection(db, 'follows'), where('targetUid', '==', ALICE), limit(30))));
  }
  await assertFails(getDocs(query(
    collection(asBob(), 'userSearch'),
    where('handle', '>=', 'al'),
    where('handle', '<=', 'al\uf8ff'),
    limit(10),
  )));

  // And so was every write: following, unfollowing, indexing, leaving the
  // index, and the admin's clean-up of a moderated entry.
  await assertFails(setDoc(doc(asAlice(), 'follows', `${ALICE}_${BOB}`), {
    followerUid: ALICE, targetUid: BOB, createdAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(asBob(), 'follows', edge)));
  await assertFails(setDoc(doc(asBob(), 'userSearch', BOB), { handle: 'bob', nameLower: 'bob' }));
  await assertFails(setDoc(doc(asAlice(), 'userSearch', ALICE), { handle: 'alice', nameLower: 'alice' }));
  await assertFails(deleteDoc(doc(asAlice(), 'userSearch', ALICE)));
  await assertFails(deleteDoc(doc(asAdmin(), 'userSearch', ALICE)));
});

// =========================================================================
// Public profiles, handles, pinned lists and the profile showcase are closed.
// The app no longer has public profiles; account deletion still removes the
// profile, handle, stash and showcase an account left behind, through the
// Worker's service account, which the rules do not govern.
// =========================================================================

test('public profiles, handles, pinned lists and the showcase are closed to every client', async () => {
  await reset();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // An explicitly public profile with its handle, showcase and stash, so
    // every refusal below comes from the closure itself.
    await setDoc(doc(db, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice', pinnedLists: [], visibility: 'public',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await setDoc(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: new Date() });
    await setDoc(doc(db, 'profileLists', ALICE), {
      lists: [{ shareId: ALICE_SHARE, title: 'A list', paperCount: 3, publishedAt: new Date() }],
      updatedAt: new Date(),
    });
    await setDoc(doc(db, 'users', ALICE, 'profileStash', 'pinnedLists'), {
      pinnedLists: [], updatedAt: new Date(),
    });
  });

  // Every read below was open to its caller before this section closed: the
  // profile, the handle and the showcase to anyone, the stash to its owner.
  for (const db of [asGuest(), asAlice(), asBob()]) {
    await assertFails(getDoc(doc(db, 'userProfiles', ALICE)));
    await assertFails(getDoc(doc(db, 'handles', 'alice')));
    await assertFails(getDoc(doc(db, 'profileLists', ALICE)));
  }
  await assertFails(getDoc(doc(asAlice(), 'users', ALICE, 'profileStash', 'pinnedLists')));
  await assertFails(getDocs(collection(asAlice(), 'users', ALICE, 'profileStash')));

  // And so was every write: creating a profile with its handle, editing it,
  // pinning a list by card and by id, parking pins in the stash and clearing
  // it, deleting a profile with its handle or the handle alone, and the
  // admin's removal of either.
  const bob = asBob();
  const create = writeBatch(bob);
  create.set(doc(bob, 'userProfiles', BOB), {
    handle: 'bob', displayName: 'Bob', pinnedLists: [], visibility: 'public',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  create.set(doc(bob, 'handles', 'bob'), { uid: BOB, createdAt: serverTimestamp() });
  await assertFails(create.commit());

  const alice = asAlice();
  await assertFails(updateDoc(doc(alice, 'userProfiles', ALICE), {
    displayName: 'Alice Again',
    pinnedLists: [{ shareId: ALICE_SHARE, title: 'A list', paperCount: 1 }],
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(alice, 'userProfiles', ALICE), {
    pinnedShareIds: [ALICE_SHARE], updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(alice, 'users', ALICE, 'profileStash', 'pinnedLists'), {
    pinnedLists: [], updatedAt: serverTimestamp(),
  }));
  const drop = writeBatch(alice);
  drop.delete(doc(alice, 'userProfiles', ALICE));
  drop.delete(doc(alice, 'handles', 'alice'));
  await assertFails(drop.commit());
  await assertFails(deleteDoc(doc(alice, 'users', ALICE, 'profileStash', 'pinnedLists')));
  await assertFails(deleteDoc(doc(alice, 'handles', 'alice')));
  await assertFails(deleteDoc(doc(asAdmin(), 'userProfiles', ALICE)));
  await assertFails(deleteDoc(doc(asAdmin(), 'handles', 'alice')));
});

// =========================================================================
// The legacy users/{uid} document
//
// An early version of the app wrote `email`, `displayName`, `photoURL` and
// `createdAt` into users/{uid}. The key allowlist there never named them, and
// every write the app makes to that document is a merge — so the allowlist
// sees the whole merged document, finds four keys it does not know, and
// denies. Confirmed in production: on an account of that vintage even an
// idempotent `{ onboardingComplete: true }` came back permission-denied, which
// took preferences, AI level, profile photo and the follows migration with it.
//
// The four keys are now tolerated but frozen: a write may carry them along, it
// may not add, edit or drop one.
// =========================================================================

/** The Auth-copy fields an account of that vintage carries. */
const LEGACY_FIELDS = {
  email: 'alice@example.test',
  displayName: 'Alice',
  photoURL: 'https://example.test/a.png',
  createdAt: new Date(2020, 0, 1),
};

/** Seeds users/{ALICE} as an old account, past the rules. Call after reset(). */
async function seedLegacyUserDoc(extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', ALICE), {
      onboardingComplete: true,
      preferences: ['astro-ph.GA'],
      ...LEGACY_FIELDS,
      ...extra,
    });
  });
}

test('an old account can make every write the app makes to its user document', async () => {
  // One case per call site that was broken: completeOnboarding,
  // updatePreferences, updateReadingPreferences and the followedAuthors
  // migration in FollowingContext. The document carries a photo uploaded
  // before uploads were removed: the allowlist must keep accepting merges
  // into it, which is why `profilePhoto` stays in the rules.
  await reset();
  await seedLegacyUserDoc({ profilePhoto: 'data:image/webp;base64,AAAA' });
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  const writes = [
    { onboardingComplete: true, preferences: ['cs.LG'] },
    { preferences: ['math.AP', 'cs.CL'] },
    { readingPreferences: { aiExplanationLevel: 'researcher', language: 'en', languagePreferenceSet: true } },
    { followedAuthors: [], followingMigratedAt: serverTimestamp() },
  ];
  for (const write of writes) {
    await assertSucceeds(setDoc(ref, write, { merge: true }));
  }
});

test('a preference list is capped at 100, and the cap is where the client says it is', async () => {
  // USER_PREFERENCES_MAX (src/utils/account-onboarding.ts) is what the pickers
  // enforce; this is the rules engine agreeing with them. One over is refused
  // outright, which is why the onboarding must never let a list that long
  // reach the write (audit of 2026-09-16, hallazgo 4).
  await reset();
  await seedLegacyUserDoc();
  const ref = doc(asAlice(), 'users', ALICE);
  const list = (n: number) => Array.from({ length: n }, (_, i) => `cat.${i}`);
  await assertSucceeds(setDoc(ref, { onboardingComplete: true, preferences: list(USER_PREFERENCES_MAX) }, { merge: true }));
  await assertFails(setDoc(ref, { onboardingComplete: true, preferences: list(USER_PREFERENCES_MAX + 1) }, { merge: true }));
  await assertFails(setDoc(ref, { preferences: list(USER_PREFERENCES_MAX + 1) }, { merge: true }));
});

test('the owner writes the subjects they removed, up to 150, and nobody else does', async () => {
  // ENG-137: users/{uid}.deselectedPreferences. The taxonomy has 149 subareas,
  // so 150 leaves room for one id retired from it.
  await reset();
  await seedLegacyUserDoc();
  const ref = doc(asAlice(), 'users', ALICE);
  const list = (n: number) => Array.from({ length: n }, (_, i) => `cat.${i}`);
  await assertSucceeds(setDoc(ref, { preferences: ['cs.LG'], deselectedPreferences: ['hep-th'] }, { merge: true }));
  await assertSucceeds(setDoc(ref, { deselectedPreferences: list(150) }, { merge: true }));
  await assertFails(setDoc(ref, { deselectedPreferences: list(151) }, { merge: true }));
  await assertFails(setDoc(ref, { deselectedPreferences: 'hep-th' }, { merge: true }));
  await assertFails(setDoc(doc(asBob(), 'users', ALICE), { deselectedPreferences: ['hep-th'] }, { merge: true }));
});

test('a legacy field cannot be given a new value', async () => {
  // The reason the four keys are frozen rather than simply allowlisted: this
  // document is owner-only, but `email` in it reads like identity, and an
  // allowlist that admits the key hands the account holder a writable one.
  await reset();
  await seedLegacyUserDoc();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  const forgeries = [
    { email: 'someone.else@example.test' },
    { displayName: 'Administrator' },
    { photoURL: 'https://example.test/other.png' },
    { createdAt: new Date(1999, 0, 1) },
  ];
  for (const forgery of forgeries) {
    await assertFails(setDoc(ref, forgery, { merge: true }));
  }
  // Rewriting a legacy field with the value it already holds is not a change,
  // so it goes through — which is exactly what every merge write does.
  await assertSucceeds(setDoc(ref, { email: LEGACY_FIELDS.email }, { merge: true }));
});

test('a user document without the legacy fields can never grow them', async () => {
  // So the old shape is terminal: no document that lacks them acquires them.
  await reset();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  // On create, where there is no previous value to compare against.
  await assertFails(setDoc(ref, { onboardingComplete: true, email: 'new@example.test' }));
  await assertSucceeds(setDoc(ref, { onboardingComplete: true }));
  // And on a later write to the document that create produced.
  await assertFails(setDoc(ref, { displayName: 'Alice' }, { merge: true }));
});

test('a legacy field cannot be dropped by the client either', async () => {
  // Deleting them is the backfill's job (P10), and a backfill runs with a
  // service identity, past these rules. Leaving the door open here would mean
  // a client could remove `createdAt` from its own document on a whim.
  await reset();
  await seedLegacyUserDoc();
  const db = asAlice();
  await assertFails(updateDoc(doc(db, 'users', ALICE), { createdAt: deleteField() }));
  await assertFails(updateDoc(doc(db, 'users', ALICE), { email: deleteField() }));
});

test('the key allowlist still bites on a legacy document', async () => {
  // Tolerating four known keys is not the same as giving up on the allowlist:
  // an unknown key and a wrongly typed value must still be refused there.
  await reset();
  await seedLegacyUserDoc();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  await assertFails(setDoc(ref, { nickname: 'alice' }, { merge: true }));
  await assertFails(setDoc(ref, { onboardingComplete: 'yes' }, { merge: true }));
  await assertFails(setDoc(ref, { profilePhoto: 'x'.repeat(280_001) }, { merge: true }));
});

test('the email digest opt-in is a bool the owner can set and then delete', async () => {
  // AuthContext writes it after onboarding, in a merge of its own, and
  // EmailNotificationsContext deletes it once the subscription exists.
  await reset();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  await assertSucceeds(setDoc(ref, { onboardingComplete: true, preferences: ['cs.LG'] }, { merge: true }));
  await assertSucceeds(setDoc(ref, { emailDigestOptIn: true }, { merge: true }));
  await assertFails(setDoc(ref, { emailDigestOptIn: 'yes' }, { merge: true }));
  await assertSucceeds(setDoc(ref, { emailDigestOptIn: deleteField() }, { merge: true }));
});

// The institution the Worker verified (worker/institution-link.js) rides on
// the same document and is frozen the same way: carried along, never written.
const INSTITUTION = {
  domain: 'usal.es',
  rorId: 'https://ror.org/02f40zc51',
  name: 'Universidad de Salamanca',
  acronym: 'USAL',
  entityId: 'https://idp.usal.es/entity',
  verifiedAt: '2026-10-13T10:00:00.000Z',
};

test('a verified institution survives the owner\'s own writes and cannot be edited or dropped', async () => {
  await reset();
  await seedLegacyUserDoc({ institution: INSTITUTION });
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  // Every merge the app makes carries the field along unchanged.
  await assertSucceeds(setDoc(ref, { preferences: ['cs.LG'] }, { merge: true }));
  await assertSucceeds(setDoc(ref, { profilePhoto: 'data:image/webp;base64,AAAA' }, { merge: true }));
  // Editing it, even one field of it, is refused; so is removing it.
  await assertFails(setDoc(ref, { institution: { ...INSTITUTION, name: 'Harvard University' } }, { merge: true }));
  await assertFails(setDoc(ref, { institution: { acronym: 'MIT' } }, { merge: true }));
  await assertFails(updateDoc(ref, { institution: deleteField() }));
  await assertFails(updateDoc(ref, { 'institution.acronym': 'MIT' }));
});

test('a client cannot award itself an institution', async () => {
  await reset();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  // Neither on create nor on a later merge into a document without one.
  await assertFails(setDoc(ref, { onboardingComplete: true, institution: INSTITUTION }));
  await assertSucceeds(setDoc(ref, { onboardingComplete: true }));
  await assertFails(setDoc(ref, { institution: INSTITUTION }, { merge: true }));
});

// =========================================================================
// Likes, saves and the feed aggregate under users/{uid}
//
// Private recommendation signals: only the account itself reads them.
// =========================================================================

test('only the owner reads the feed aggregate and the likes behind it', async () => {
  // A feed load reads one document, the interaction aggregate, and the rules
  // must let the owner make that read: if a rules change broke it, every load
  // would fall back to the bounded rebuild, one read per interaction document.
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', ALICE, 'aggregates', 'interactions'), {
      version: 1, updatedAt: new Date(), sourceDocCount: 3, payload: '{}',
    });
    for (const paperId of ['p1', 'p2', 'p3']) {
      await setDoc(doc(db, 'users', ALICE, 'interactions', paperId), {
        liked: true, updatedAt: new Date(),
      });
    }
  });

  const aggregate = await getDoc(doc(asAlice(), 'users', ALICE, 'aggregates', 'interactions'));
  assert.ok(aggregate.exists(), 'the owner can read her feed aggregate');
  assert.equal(aggregate.data()!.sourceDocCount, 3, 'and that document is the usable one');

  // The likes behind it stay the owner's: another account reads neither the
  // aggregate nor the interactions it is built from.
  await assertFails(getDoc(doc(asBob(), 'users', ALICE, 'aggregates', 'interactions')));
  await assertFails(getDocs(query(collection(asBob(), 'users', ALICE, 'interactions'), limit(10))));
});

// =========================================================================
// Public lists after F11: server-written, client-readable
//
// This is the coverage whose absence let publishing ship broken. Every test
// above seeds `publicLists` with the rules switched off; none of them ever
// asked the rules engine what a CLIENT is allowed to do to that collection.
// =========================================================================

/** Papers as sanitizePublicPaper() leaves them — the payload that broke. */
const publicPapers = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: `arxiv:2608.${18000 + i}`,
  title: `Paper ${i}`,
  authors: Array.from({ length: 20 }, (_, a) => `Author ${a}`),
  abstract: 'x'.repeat(1200),
  year: 2026,
  category: 'cs.LG',
  concepts: Array.from({ length: 12 }, (_, c) => `concept ${c}`),
  citations: 42,
  doi: `10.1234/papertok.${i}`,
  arxivId: `2608.${18000 + i}`,
  openUrl: `https://arxiv.org/abs/2608.${18000 + i}`,
}));

const publicListBody = (papers: ReturnType<typeof publicPapers>) => ({
  title: 'Mi bibliografía',
  language: 'es',
  paperCount: papers.length,
  papers,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
});

/** Seeds a live public list plus the owner's private list pointing at it. */
async function seedPublished({ shareId = ALICE_SHARE, listId = 'l1', papers = 3 } = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'publicLists', shareId), {
      ...publicListBody(publicPapers(papers)),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await setDoc(doc(db, 'users', ALICE, 'lists', listId), {
      id: listId, name: 'Mi lista', emoji: '📚', paperIds: [], createdAt: new Date(),
      publicShareId: shareId,
    });
  });
}

test('anyone, signed in or not, can still read a share link in one document', async () => {
  await reset();
  await seedPublished();
  for (const db of [asGuest(), asAlice(), asBob()]) {
    const snapshot = await assertSucceeds(getDoc(doc(db, 'publicLists', ALICE_SHARE)));
    assert.equal(snapshot.data()!.papers.length, 3);
  }
});

test('the owner cannot write their own public list from the client', async () => {
  await reset();
  const db = asAlice();
  // The exact batch publishPublicList() used to commit, with one paper.
  await assertFails((() => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'publicListOwners', GHOST_SHARE), {
      ownerId: ALICE, listId: 'l1', createdAt: serverTimestamp(),
    });
    batch.set(doc(db, 'publicLists', GHOST_SHARE), publicListBody(publicPapers(1)));
    return batch.commit();
  })());
  // And each document on its own, so no path is left open.
  await assertFails(setDoc(doc(db, 'publicLists', GHOST_SHARE), publicListBody(publicPapers(1))));
  await assertFails(setDoc(doc(db, 'publicListOwners', GHOST_SHARE), {
    ownerId: ALICE, listId: 'l1', createdAt: serverTimestamp(),
  }));
});

test('the owner cannot edit or delete a live public list from the client', async () => {
  await reset();
  await seedPublished();
  const db = asAlice();
  await assertFails(updateDoc(doc(db, 'publicLists', ALICE_SHARE), {
    title: 'Cambiado', updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, 'publicLists', ALICE_SHARE)));
  await assertFails(deleteDoc(doc(db, 'publicListOwners', ALICE_SHARE)));
});

test('the owner table is not readable, so share ids do not map to accounts', async () => {
  await reset();
  for (const db of [asGuest(), asAlice(), asBob()]) {
    await assertFails(getDoc(doc(db, 'publicListOwners', ALICE_SHARE)));
    await assertFails(getDocs(collection(db, 'publicListOwners')));
  }
});

test('nobody can claim somebody else\'s share in the owner table', async () => {
  await reset();
  // Bob's share exists; rewriting its owner record would hand Alice his list.
  await assertFails(setDoc(doc(asAlice(), 'publicListOwners', BOB_SHARE), {
    ownerId: ALICE, listId: 'l2', createdAt: serverTimestamp(),
  }));
});

test('nobody can page the public list collection, only fetch a known share', async () => {
  await reset();
  await seedPublished();
  await assertFails(getDocs(query(collection(asGuest(), 'publicLists'), limit(10))));
});

// -------------------------------------------------------------------------
// The pointer, and the delete rule that leans on it.
// -------------------------------------------------------------------------

test('a published private list cannot be deleted while it is published', async () => {
  await reset();
  await seedPublished();
  // The public documents are still standing; deleting the private one would
  // orphan them beyond anyone's reach.
  await assertFails(deleteDoc(doc(asAlice(), 'users', ALICE, 'lists', 'l1')));
});

test('once unpublished, the private list deletes normally', async () => {
  await reset();
  await seedPublished();
  // What the Worker's unpublish commit leaves behind.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await deleteDoc(doc(db, 'publicLists', ALICE_SHARE));
    await deleteDoc(doc(db, 'publicListOwners', ALICE_SHARE));
    await updateDoc(doc(db, 'users', ALICE, 'lists', 'l1'), { publicShareId: deleteField() });
  });
  await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE, 'lists', 'l1')));
});

test('the client cannot clear the pointer to escape the delete rule', async () => {
  await reset();
  await seedPublished();
  const db = asAlice();
  // Dropping the field would make the list deletable while its public copy
  // still stands: the exact orphan the delete rule exists to prevent.
  await assertFails(updateDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    publicShareId: deleteField(),
  }));
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    id: 'l1', name: 'Mi lista', emoji: '📚', paperIds: [], createdAt: new Date(),
  }));
});

test('the client cannot forge or repoint a pointer at somebody else share', async () => {
  await reset();
  const db = asAlice();
  // Inventing one on a fresh list.
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'brand-new'), {
    id: 'brand-new', name: 'Nueva', emoji: '📚', paperIds: [], createdAt: new Date(),
    publicShareId: BOB_SHARE,
  }));
  // Repointing an existing one.
  await seedPublished();
  await assertFails(updateDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    publicShareId: BOB_SHARE,
  }));
});

test('an ordinary edit of a published list still works, pointer carried along', async () => {
  await reset();
  await seedPublished();
  const db = asAlice();
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    name: 'Otro nombre', paperIds: ['arxiv:2608.18000'],
  }));
  // Including a full set that repeats the pointer unchanged, which is what a
  // whole-document save from the client looks like.
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    id: 'l1', name: 'Tercero', emoji: '📚', paperIds: [], createdAt: new Date(),
    publicShareId: ALICE_SHARE,
  }));
});

test('an unpublished list is created and deleted freely, as before', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'plain'), {
    id: 'plain', name: 'Sin publicar', emoji: '📚', paperIds: [], createdAt: new Date(),
  }));
  await assertSucceeds(deleteDoc(doc(db, 'users', ALICE, 'lists', 'plain')));
});

// =========================================================================
// Colour of a list (0.2 palette). The client has written `color` since the
// palette landed; these are the writes it actually makes.
// =========================================================================

test('creating a list with a palette colour is allowed, from both create paths', async () => {
  await reset();
  const db = asAlice();
  // ListsPage.handleCreateList and SaveToListModal.handleCreateList write this
  // exact shape: createdAt as an ISO string, colour as a palette id.
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'list_1'), {
    id: 'list_1', name: 'Nueva', emoji: 'Folder', color: 'indigo',
    paperIds: [], createdAt: new Date().toISOString(),
  }));
});

test('editing name, icon and colour together is allowed, on a plain and on a published list', async () => {
  await reset();
  await seedPublished();
  const db = asAlice();
  // ListsPage.handleEditList: a partial update, `updatedAt` from the server.
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'l1'), {
    name: 'Papers de mugar', emoji: 'Folder', color: 'indigo', updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'plain'), {
    id: 'plain', name: 'Sin publicar', emoji: '📚', paperIds: [], createdAt: new Date(),
  }));
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'plain'), {
    name: 'Renombrada', emoji: 'Star', color: 'teal', updatedAt: serverTimestamp(),
  }));
});

test('every id of the palette is accepted, and nothing outside it', async () => {
  await reset();
  const db = asAlice();
  // Ties the hand-copied list in the rules to the one the picker offers: a
  // colour added to LIST_COLORS without touching the rules fails here.
  for (const color of LIST_COLORS) {
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', `c-${color}`), {
      id: `c-${color}`, name: 'Color', emoji: 'Folder', color,
      paperIds: [], createdAt: new Date().toISOString(),
    }));
  }
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'bad-1'), {
    id: 'bad-1', name: 'Color', emoji: 'Folder', color: '#ff0000',
    paperIds: [], createdAt: new Date().toISOString(),
  }));
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'bad-2'), {
    id: 'bad-2', name: 'Color', emoji: 'Folder', color: 7,
    paperIds: [], createdAt: new Date().toISOString(),
  }));
  await assertFails(updateDoc(doc(db, 'users', ALICE, 'lists', 'c-teal'), { color: 'magenta' }));
});

test('a list without colour is still valid: the ones made before the palette', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'old'), {
    id: 'old', name: 'De antes', emoji: '📚', paperIds: [], createdAt: new Date(),
  }));
  await assertSucceeds(updateDoc(doc(db, 'users', ALICE, 'lists', 'old'), {
    name: 'Renombrada sin color', updatedAt: serverTimestamp(),
  }));
});

test('F12: a private list carries the sync and attribution stamps', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'lists', 'l9'), {
    id: 'l9', name: 'Con sellos', emoji: '📌', paperIds: [],
    createdAt: new Date(), onProfile: true, updatedAt: new Date(),
    publicSyncedAt: new Date(),
  }));
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'l10'), {
    id: 'l10', name: 'Mal sello', emoji: '📌', paperIds: [],
    createdAt: new Date(), onProfile: 'yes',
  }));
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'l11'), {
    id: 'l11', name: 'Mal sello', emoji: '📌', paperIds: [],
    createdAt: new Date(), updatedAt: 'ayer',
  }));
  await assertFails(setDoc(doc(db, 'users', ALICE, 'lists', 'l12'), {
    id: 'l12', name: 'Mal sello', emoji: '📌', paperIds: [],
    createdAt: new Date(), publicSyncedAt: 'nunca',
  }));
});

// =========================================================================
// P19: reader highlights — users/{uid}/highlights
//
// The clause validates ten fields and shipped with no test at all, which is
// the exact shape the suite exists to catch: an allowlist reads correct and
// denies nothing until something writes through it. `src/services/
// user-highlight-service.ts` is the only writer, so every body below is one the
// client could actually produce.
// =========================================================================

/** A highlight exactly as `normalizeUserHighlight` builds one. */
function highlightBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paperId: 'arxiv:2401.00001',
    level: 'university',
    language: 'es',
    sectionId: 'results',
    paragraphIndex: 3,
    quote: 'a quote long enough to anchor',
    kind: 'user',
    paperTitle: 'A rewritten paper',
    createdAt: serverTimestamp(),
    ...extra,
  };
}

function highlightWithout(field: string) {
  const body = highlightBody();
  delete body[field];
  return body;
}

const highlightRef = (database: ReturnType<typeof asAlice>, id = 'h1', uid = ALICE) => (
  doc(database, 'users', uid, 'highlights', id)
);

/** The query `listUserHighlights` actually emits, ceiling and all. */
const highlightsQuery = (database: ReturnType<typeof asAlice>, uid = ALICE, paperId = 'arxiv:2401.00001', rows = 200) => query(
  collection(database, 'users', uid, 'highlights'),
  where('paperId', '==', paperId),
  limit(rows),
);

/** Seeds one of Alice's highlights past the rules, for the cross-user tests. */
async function seedHighlight(id = 'h1') {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', ALICE, 'highlights', id), {
      ...highlightBody(), createdAt: new Date(),
    });
  });
}

test('P19: a reader saves, re-saves, reads and deletes their own highlight', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
  await assertSucceeds(getDoc(highlightRef(db)));
  await assertSucceeds(getDocs(highlightsQuery(db)));
  // The id is a fingerprint of the selection, so saving the same passage twice
  // updates one document rather than adding a second.
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
  await assertSucceeds(deleteDoc(highlightRef(db)));
});

test('P19: another account can neither read, write nor delete a highlight', async () => {
  await reset();
  await seedHighlight();
  for (const db of [asBob(), asGuest()]) {
    await assertFails(getDoc(highlightRef(db)));
    // Capped exactly as the owner's own reader would ask, so the only thing
    // wrong with this query is who is asking it.
    await assertFails(getDocs(highlightsQuery(db)));
    await assertFails(setDoc(highlightRef(db), highlightBody()));
    await assertFails(setDoc(highlightRef(db, 'planted'), highlightBody()));
    await assertFails(deleteDoc(highlightRef(db)));
  }
  // The document Bob tried to delete is still Alice's, and still there.
  await assertSucceeds(getDoc(highlightRef(asAlice())));
});

test('P19: a highlight list has to carry the ceiling the reader uses', async () => {
  // The accepted case matters as much as the refused ones: it is the exact
  // query `listUserHighlights` emits, and a rule that refused it would break
  // the reader rather than protect anything.
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
  const highlights = () => collection(db, 'users', ALICE, 'highlights');
  await assertFails(getDocs(highlights()));
  await assertFails(getDocs(query(highlights(), where('paperId', '==', 'arxiv:2401.00001'))));
  await assertFails(getDocs(query(highlights(), limit(201))));
  await assertSucceeds(getDocs(highlightsQuery(db)));
  await assertSucceeds(getDocs(query(highlights(), limit(200))));
  // Fetching one highlight by id never went through the ceiling, and still
  // does not — the id is a fingerprint the client can rebuild.
  await assertSucceeds(getDoc(highlightRef(db)));
});

test('P19: a field outside the allowlist is refused', async () => {
  await reset();
  const db = asAlice();
  // The extra key has to ride along with an OTHERWISE VALID document, or
  // another clause denies the write on its own and `hasOnly` never gets a say.
  await assertFails(setDoc(highlightRef(db), highlightBody({ smuggled: 'anything' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ color: 'yellow' })));
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
});

test('P19: a quote under eight characters or over four hundred is refused', async () => {
  await reset();
  const db = asAlice();
  await assertFails(setDoc(highlightRef(db), highlightBody({ quote: 'siete c' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ quote: '' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ quote: 'a'.repeat(401) })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ quote: 42 })));
  // Both ends of the range the client enforces, asserted so a later trim to
  // either bound fails here first.
  await assertSucceeds(setDoc(highlightRef(db), highlightBody({ quote: 'a'.repeat(8) })));
  await assertSucceeds(setDoc(highlightRef(db), highlightBody({ quote: 'a'.repeat(400) })));
});

test('P19: paragraphIndex is a whole number from zero to one hundred', async () => {
  await reset();
  const db = asAlice();
  for (const paragraphIndex of [1.5, '3', -1, 101, null]) {
    await assertFails(setDoc(highlightRef(db), highlightBody({ paragraphIndex })));
  }
  for (const paragraphIndex of [0, 100]) {
    await assertSucceeds(setDoc(highlightRef(db), highlightBody({ paragraphIndex })));
  }
});

test('P19: level and language accept only the values the reader can pick', async () => {
  await reset();
  const db = asAlice();
  await assertFails(setDoc(highlightRef(db), highlightBody({ level: 'expert' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ level: '' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ language: 'fr' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ language: 'ES' })));
  // Absent, not merely wrong: dereferencing a missing key denies the write.
  await assertFails(setDoc(highlightRef(db), highlightWithout('level')));
  await assertFails(setDoc(highlightRef(db), highlightWithout('language')));
  for (const level of ['beginner', 'university', 'researcher']) {
    await assertSucceeds(setDoc(highlightRef(db), highlightBody({ level })));
  }
  for (const language of ['es', 'en']) {
    await assertSucceeds(setDoc(highlightRef(db), highlightBody({ language })));
  }
});

test('P19: an empty sectionId or paperId is refused, an empty paperTitle is not', async () => {
  // `validString` asks only for `is string && size() <= max`, so '' satisfied
  // both. The client refuses either — `normalizeUserHighlight` returns null —
  // and now so does the database, since both feed the id fingerprint and
  // `listUserHighlights` filters on paperId. `paperTitle` stays permissive on
  // purpose: the same service writes '' whenever the title is unknown, so
  // requiring it would deny an ordinary save.
  await reset();
  const db = asAlice();
  await assertFails(setDoc(highlightRef(db), highlightBody({ sectionId: '' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ paperId: '' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ sectionId: 'a'.repeat(41) })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ paperId: 'a'.repeat(401) })));
  await assertFails(setDoc(highlightRef(db), highlightWithout('sectionId')));
  await assertSucceeds(setDoc(highlightRef(db), highlightBody({ paperTitle: '' })));
});

test('P19: createdAt has to be the stamp the server writes', async () => {
  // It sat in the allowlist with no check of any kind, so a client could date
  // a highlight to 2019 or store a string there. `serverTimestamp()` resolves
  // to `request.time`, which is what the service already sends.
  await reset();
  const db = asAlice();
  await assertFails(setDoc(highlightRef(db), highlightBody({ createdAt: new Date('2019-01-01') })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ createdAt: 'ayer' })));
  await assertFails(setDoc(highlightRef(db), highlightBody({ createdAt: 0 })));
  await assertFails(setDoc(highlightRef(db), highlightWithout('createdAt')));
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
});

test('P19: an update cannot move a highlight to a different paper', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
  // A complete, otherwise valid rewrite. The only thing wrong with it is that
  // the document id is a fingerprint of the paperId it no longer carries, so
  // the highlight would surface under a paper `buildHighlightId` never keyed.
  await assertFails(setDoc(highlightRef(db), highlightBody({ paperId: 'arxiv:2401.99999' })));
  // Re-saving the same selection is untouched, which is what the client does.
  await assertSucceeds(setDoc(highlightRef(db), highlightBody()));
  // And a new document is free to carry any paperId at all.
  await assertSucceeds(setDoc(highlightRef(db, 'h2'), highlightBody({ paperId: 'arxiv:2401.99999' })));
});

test('P19: kind, note and paperTitle are optional, and bounded when present', async () => {
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(highlightRef(db, 'h1'), highlightWithout('kind')));
  await assertSucceeds(setDoc(highlightRef(db, 'h2'), highlightWithout('paperTitle')));
  await assertSucceeds(setDoc(highlightRef(db, 'h3'), highlightBody({ note: 'a'.repeat(2000) })));
  await assertSucceeds(setDoc(highlightRef(db, 'h4'), highlightBody({ kind: 'caveat' })));
  await assertFails(setDoc(highlightRef(db, 'h5'), highlightBody({ kind: 'sneaky' })));
  await assertFails(setDoc(highlightRef(db, 'h6'), highlightBody({ note: 'a'.repeat(2001) })));
  await assertFails(setDoc(highlightRef(db, 'h7'), highlightBody({ paperTitle: 'a'.repeat(1001) })));
});

test('P20: an annotation the model wrote is storable, and only from the known kinds', async () => {
  // `kind` is what tells the three things in this collection apart: a bare
  // highlight, a highlight you wrote on, and an answer the model wrote about the
  // passage. Only the last is 'ai', and the reader renders its mark and its rail
  // card from that one field — so a rule that refuses it does not degrade the
  // feature, it deletes it silently at the write.
  await reset();
  const db = asAlice();
  await assertSucceeds(setDoc(highlightRef(db, 'a1'), highlightBody({
    kind: 'ai',
    note: 'Antes medías un tiempo y salía un valor; ahora sale un abanico.',
  })));
  // The allowlist did not widen into "anything goes".
  await assertFails(setDoc(highlightRef(db, 'a2'), highlightBody({ kind: 'assistant' })));
  await assertFails(setDoc(highlightRef(db, 'a3'), highlightBody({ kind: 'AI' })));
});

test('P20: an AI annotation at full length is still a clean allow', async () => {
  // The same expression-budget guard as the highlight below, for the shape the
  // annotation route actually writes: a 'ai' kind with a note on it.
  await reset();
  await assertSucceeds(setDoc(highlightRef(asAlice()), highlightBody({
    paperId: 'a'.repeat(400),
    sectionId: 'a'.repeat(40),
    quote: 'a'.repeat(400),
    note: 'a'.repeat(2000),
    paperTitle: 'a'.repeat(1000),
    paragraphIndex: 100,
    kind: 'ai',
  })));
});

test('P19: the heaviest highlight a reader can write is a clean allow', async () => {
  // The rules engine stops at 1000 evaluated expressions per request, and it
  // fails with an error rather than a denial — see tests/README.md, and the
  // note there that only `allowed` is a reliable signal. This is the largest
  // document the allowlist admits, so a later clause that pushes the
  // highlights branch past the budget stops saves here first.
  await reset();
  await assertSucceeds(setDoc(highlightRef(asAlice()), highlightBody({
    paperId: 'a'.repeat(400),
    sectionId: 'a'.repeat(40),
    quote: 'a'.repeat(400),
    note: 'a'.repeat(2000),
    paperTitle: 'a'.repeat(1000),
    paragraphIndex: 99,
    endParagraphIndex: 100,
    endQuote: 'a'.repeat(400),
    kind: 'caveat',
  })));
});

test('P19: a passage across paragraphs ends later in the same section, with its end quote', async () => {
  await reset();
  const alice = asAlice();
  await assertSucceeds(setDoc(highlightRef(alice, 'span'), highlightBody({ endParagraphIndex: 4, endQuote: 'the end' })));
  await assertFails(setDoc(highlightRef(alice, 'back'), highlightBody({ endParagraphIndex: 3, endQuote: 'the end' })));
  await assertFails(setDoc(highlightRef(alice, 'far'), highlightBody({ endParagraphIndex: 101, endQuote: 'the end' })));
  await assertFails(setDoc(highlightRef(alice, 'float'), highlightBody({ endParagraphIndex: 4.5, endQuote: 'the end' })));
  await assertFails(setDoc(highlightRef(alice, 'noquote'), highlightBody({ endParagraphIndex: 4 })));
  await assertFails(setDoc(highlightRef(alice, 'empty'), highlightBody({ endParagraphIndex: 4, endQuote: '' })));
  await assertFails(setDoc(highlightRef(alice, 'long'), highlightBody({ endParagraphIndex: 4, endQuote: 'a'.repeat(401) })));
  await assertFails(setDoc(highlightRef(alice, 'orphan'), highlightBody({ endQuote: 'the end' })));
});

/* --- The payload the save modal actually sends ---------------------------- */

/**
 * A rule and the client that feeds it drifted apart in silence, and the cost
 * was permanent.
 *
 * The rules accept an optional field that is absent and refuse one that is
 * `null`, except `doi` and `landingPageUrl` which carry an explicit escape. The
 * modal wrote `null` for every absent field — deliberately, because Firestore
 * rejects `undefined` — so a paper with no abstract or no authors had its write
 * REFUSED. And the modal added the id to the list first, so the refusal left a
 * list entry with no document behind it: a row rendering as a bare arXiv id,
 * for good.
 *
 * Nothing could have caught that from either side alone. So this checks the
 * two together, on the shapes that actually broke.
 */
test('savedPapers accepts what buildSavedPaperPayload sends, for a paper missing everything optional', async () => {
  const db = asAlice();
  const savedAt = new Date().toISOString();

  const papers: [string, NonNullable<Parameters<typeof buildSavedPaperPayload>[0]> & { id: string }][] = [
    ['the full article', {
      id: '2608.20113', title: 'A metallicity sweet spot for disc fragmentation',
      authors: ['Ethan J. Carter'], primaryCategory: 'astro-ph.EP',
      published: '2026-08-01', arxivId: '2608.20113',
      summary: 'Disc fragmentation depends on metallicity.',
      doi: '10.48550/arXiv.2608.20113', landingPageUrl: 'https://arxiv.org/abs/2608.20113',
    }],
    ['no abstract', { id: '2608.20071', title: 'Inflation on the lattice', authors: ['Fei-Yu Chen'] }],
    ['no authors', { id: '2608.20072', title: 'Pomeranchuk instability', summary: 'Some text.' }],
    ['nothing but an id', { id: '2608.20073' }],
  ];

  for (const [label, paper] of papers) {
    await (assertSucceeds as (promise: Promise<void>, label: string) => Promise<void>)(
      setDoc(
        doc(db, 'users', ALICE, 'savedPapers', paper.id),
        buildSavedPaperPayload(paper, savedAt),
      ),
      `${label}: the rules must accept the payload the modal sends`,
    );
  }
});

test('the shape the modal used to send is still refused, so the fix is load-bearing', async () => {
  const db = asAlice();
  // Exactly what the old code built for a paper with no abstract.
  await assertFails(setDoc(doc(db, 'users', ALICE, 'savedPapers', '2608.99999'), {
    title: 'Inflation on the lattice',
    authors: ['Fei-Yu Chen'],
    primaryCategory: 'gr-qc',
    published: '2026-08-01',
    arxivId: '2608.99999',
    summary: null,
    doi: null,
    landingPageUrl: null,
    savedAt: new Date().toISOString(),
  }));
});

/* --- Plain-words summaries (PAP-59) ---------------------------------------- */

/**
 * A reader's finished rewrites, kept in two documents per paper and level:
 * `summaries` holds the text and is fetched one at a time when the paper opens,
 * `summaryHistory` holds the row the history pages through. The payloads and
 * the history query below are the ones `savedSummaryService` builds, so a rule
 * that refused the client's own write fails here rather than in a reader's
 * console.
 */
const SUMMARY_PDF = 'https://arxiv.org/pdf/2401.00001.pdf';
const SUMMARY_SECTION = {
  id: 's0',
  kind: 'intro',
  heading: 'What they asked',
  originalHeading: '1 Introduction',
  paragraphs: ['First paragraph.', 'Second paragraph.'],
  highlights: [{ paragraphIndex: 1, quote: 'Second paragraph', kind: 'finding' }],
};
const SUMMARY_PAPER = { id: '2401.00001v1', arxivId: '2401.00001v1', title: 'A paper about $x^2$' };
type RulesDb = ReturnType<typeof asAlice>;

function summaryWrite(paper: typeof SUMMARY_PAPER = SUMMARY_PAPER, level = 'university', sections: object[] = [SUMMARY_SECTION]) {
  const write = buildSummaryWrite(paper, level, { sections: sections as never, model: 'deepseek-v4-flash', sourceBasis: 'full_text', promptVersion: 'paper-rewrite-v3' }, SUMMARY_PDF);
  assert.ok(write, 'the client has to be able to build the write under test');
  return write;
}

const summaryRef = (database: RulesDb, id: string, uid = ALICE) => doc(database, 'users', uid, 'summaries', id);
const historyRef = (database: RulesDb, id: string, uid = ALICE) => doc(database, 'users', uid, 'summaryHistory', id);

/** The batch `saveSummary` commits, with fields overridden or removed (`undefined`) per document. */
function saveSummaryBatch(database: RulesDb, {
  uid = ALICE,
  write = summaryWrite(),
  summary = {} as Record<string, unknown>,
  history = {} as Record<string, unknown>,
} = {}) {
  const strip = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  const batch = writeBatch(database);
  batch.set(summaryRef(database, write.id, uid), strip({ ...write.summary, ...summary }));
  batch.set(historyRef(database, write.id, uid), strip({ ...write.history, updatedAt: serverTimestamp(), ...history }));
  return batch.commit();
}

/** A page of history exactly as `listSummaryHistory` asks for it. */
const historyPage = (database: RulesDb, uid = ALICE, cursor: Parameters<typeof buildSummaryHistoryQuery>[1] = null) => (
  getDocs(buildSummaryHistoryQuery(uid, cursor, { database: database as never }))
);

async function seedSummary(write = summaryWrite()) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', ALICE, 'summaries', write.id), write.summary);
    await setDoc(doc(db, 'users', ALICE, 'summaryHistory', write.id), { ...write.history, updatedAt: new Date() });
  });
}

test('PAP-59: a reader saves, reopens, pages, rewrites and deletes their own summaries', async () => {
  await reset();
  const db = asAlice();
  const first = summaryWrite();
  const second = summaryWrite({ ...SUMMARY_PAPER, id: '2401.00002', arxivId: '2401.00002' }, 'beginner');
  await assertSucceeds(saveSummaryBatch(db, { write: first }));
  await assertSucceeds(saveSummaryBatch(db, { write: second }));
  const saved = await assertSucceeds(getDoc(summaryRef(db, first.id)));
  assert.deepEqual(saved.data(), first.summary);
  const page = await assertSucceeds(historyPage(db));
  assert.deepEqual(page.docs.map(row => row.id).sort(), [first.id, second.id].sort());
  await assertSucceeds(historyPage(db, ALICE, page.docs[0] as never));
  // Writing the paper again replaces both documents in place.
  await assertSucceeds(saveSummaryBatch(db, { write: first, summary: { model: 'another-model' } }));
  assert.equal((await getDoc(summaryRef(db, first.id))).data()?.model, 'another-model');
  await assertSucceeds(deleteDoc(summaryRef(db, first.id)));
  await assertSucceeds(deleteDoc(historyRef(db, first.id)));
});

test('PAP-59: another account or a guest can neither read, page, write nor delete a summary', async () => {
  await reset();
  const write = summaryWrite();
  await seedSummary(write);
  for (const db of [asBob(), asGuest()]) {
    await assertFails(getDoc(summaryRef(db, write.id)));
    await assertFails(getDoc(historyRef(db, write.id)));
    // The page the owner's own history asks for, so the only thing wrong with
    // it is who is asking.
    await assertFails(historyPage(db));
    await assertFails(saveSummaryBatch(db));
    await assertFails(setDoc(summaryRef(db, write.id), write.summary));
    await assertFails(deleteDoc(summaryRef(db, write.id)));
    await assertFails(deleteDoc(historyRef(db, write.id)));
  }
  const alice = asAlice();
  assert.deepEqual((await getDoc(summaryRef(alice, write.id))).data(), write.summary);
  assert.equal((await getDoc(historyRef(alice, write.id))).exists(), true);
});

test('PAP-59: the text is fetched one summary at a time, never listed', async () => {
  await reset();
  await seedSummary();
  const db = asAlice();
  const summaries = collection(db, 'users', ALICE, 'summaries');
  await assertFails(getDocs(summaries));
  await assertFails(getDocs(query(summaries, limit(1))));
});

test('PAP-59: a history page has to carry the ceiling the client asks for', async () => {
  await reset();
  await seedSummary();
  const db = asAlice();
  const history = collection(db, 'users', ALICE, 'summaryHistory');
  await assertFails(getDocs(history));
  await assertFails(getDocs(query(history, limit(SUMMARY_HISTORY_PAGE_SIZE + 2))));
  await assertSucceeds(getDocs(query(history, limit(SUMMARY_HISTORY_PAGE_SIZE + 1))));
  await assertSucceeds(historyPage(db));
});

test('PAP-59: a summary holds its sections, model, source basis and prompt version, and nothing else', async () => {
  await reset();
  const db = asAlice();
  const write = summaryWrite();
  // Each refusal rides on an otherwise valid batch, so the clause under test is
  // the only one that can deny it.
  await assertFails(saveSummaryBatch(db, { summary: { paperTitle: 'A paper about $x^2$' } }));
  await assertFails(saveSummaryBatch(db, { summary: { sourceBasis: undefined } }));
  await assertFails(saveSummaryBatch(db, { summary: { model: undefined } }));
  await assertFails(saveSummaryBatch(db, { summary: { sections: [] } }));
  await assertFails(saveSummaryBatch(db, { summary: { sections: 'First paragraph.' } }));
  await assertFails(saveSummaryBatch(db, { summary: { sections: Array.from({ length: 25 }, (_, index) => ({ ...SUMMARY_SECTION, id: `s${index}` })) } }));
  await assertFails(saveSummaryBatch(db, { summary: { model: 'm'.repeat(101) } }));
  await assertFails(saveSummaryBatch(db, { summary: { sourceBasis: 'f'.repeat(41) } }));
  await assertFails(saveSummaryBatch(db, { summary: { promptVersion: undefined } }));
  await assertFails(saveSummaryBatch(db, { summary: { promptVersion: 3 } }));
  await assertFails(saveSummaryBatch(db, { summary: { promptVersion: 'v'.repeat(41) } }));
  // An unknown basis or prompt version is stored as unknown, and the longest
  // rewrite the client keeps is a clean allow.
  await assertSucceeds(saveSummaryBatch(db, { summary: { sourceBasis: '' } }));
  await assertSucceeds(saveSummaryBatch(db, { summary: { promptVersion: '' } }));
  const longest = summaryWrite(SUMMARY_PAPER, 'researcher', Array.from({ length: 24 }, (_, index) => ({ ...SUMMARY_SECTION, id: `s${index}` })));
  await assertSucceeds(saveSummaryBatch(db, { write: longest }));
  // The id has to be a paper key and a level, like every id the client builds.
  await assertFails(setDoc(summaryRef(db, 'not a key.university'), write.summary));
  await assertFails(setDoc(summaryRef(db, write.id.replace(/\.university$/, '')), write.summary));
  await assertFails(setDoc(summaryRef(db, write.id.replace(/university$/, 'expert')), write.summary));
});

test('PAP-59: a history row names its paper, level, title and PDF, stamped by the server', async () => {
  await reset();
  const db = asAlice();
  const other = summaryWrite({ ...SUMMARY_PAPER, id: '2401.00002', arxivId: '2401.00002' });
  await assertFails(saveSummaryBatch(db, { history: { abstract: 'Smuggled text.' } }));
  await assertFails(saveSummaryBatch(db, { history: { title: '' } }));
  await assertFails(saveSummaryBatch(db, { history: { title: 't'.repeat(1001) } }));
  await assertFails(saveSummaryBatch(db, { history: { paperId: '' } }));
  await assertFails(saveSummaryBatch(db, { history: { level: 'expert' } }));
  // A row has to describe the summary its id names: another paper's key or
  // another level would reopen a summary that is not there.
  await assertFails(saveSummaryBatch(db, { history: { paperKey: other.history.paperKey } }));
  await assertFails(saveSummaryBatch(db, { history: { level: 'beginner' } }));
  await assertFails(saveSummaryBatch(db, { history: { pdfUrl: 'http://arxiv.org/pdf/2401.00001.pdf' } }));
  await assertFails(saveSummaryBatch(db, { history: { pdfUrl: 'javascript:alert(1)' } }));
  await assertFails(saveSummaryBatch(db, { history: { pdfUrl: `https://arxiv.org/${'p'.repeat(2000)}` } }));
  await assertFails(saveSummaryBatch(db, { history: { updatedAt: new Date('2026-01-01T00:00:00Z') } }));
  await assertFails(saveSummaryBatch(db, { history: { updatedAt: undefined } }));
  await assertSucceeds(saveSummaryBatch(db));
});

/*
 * PAP-60. A saved paper keeps the evidence its field was read from: arXiv's
 * categories and OpenAlex's primary topic, by id and name, under a
 * classification version. These check the rules against what
 * buildSavedPaperPayload sends, at the largest size it can send.
 */
const STORED_TOPIC = {
  id: 'https://openalex.org/T12929',
  display_name: 'Animal Genetics and Reproduction',
  subfield: { id: 'https://openalex.org/subfields/1311', display_name: 'Genetics' },
  field: { id: 'https://openalex.org/fields/13', display_name: 'Biochemistry, Genetics and Molecular Biology' },
  domain: { id: 'https://openalex.org/domains/1', display_name: 'Life Sciences' },
};
// W2120490784's primary topic as OpenAlex sends it; the copy drops the score.
const CAT_EMBRYO_TOPIC = { ...STORED_TOPIC, score: 0.9492 };

test('savedPapers accepts the classification evidence buildSavedPaperPayload sends', async () => {
  await reset();
  const db = asAlice();
  const savedAt = new Date().toISOString();
  const longest = (prefix: string) => `${prefix}${'x'.repeat(300 - prefix.length)}`;

  const papers: [string, NonNullable<Parameters<typeof buildSavedPaperPayload>[0]> & { id: string }][] = [
    ['an arXiv paper and its cross-lists', {
      id: '2605.02209', title: 'Agents that plan', primaryCategory: 'cs.AI', categories: ['cs.AI', 'cs.LG', 'cs.CL'],
      arxivId: '2605.02209',
    }],
    ['an OpenAlex work, its topic and more concept names than the cap', {
      id: 'openalex:W2120490784',
      title: 'In vitro developmental competence of domestic cat embryos after somatic cloning: a preliminary report',
      primaryTopic: CAT_EMBRYO_TOPIC,
      categories: Array.from({ length: 30 }, (_, index) => `Concept ${index}`),
      doi: '10.1016/s0093-691x(02)01047-6',
    }],
    ['every field at its largest', {
      id: 'openalex:W1',
      title: 'T'.repeat(1000),
      authors: ['A', 'B', 'C', 'D', 'E', 'F'],
      primaryCategory: 'p'.repeat(300),
      categories: Array.from({ length: 20 }, (_, index) => `c${index}`.repeat(10)),
      primaryTopic: {
        id: longest('https://openalex.org/T'),
        display_name: longest('Topic '),
        subfield: { id: longest('https://openalex.org/subfields/'), display_name: longest('Subfield ') },
        field: { id: longest('https://openalex.org/fields/'), display_name: longest('Field ') },
        domain: { id: longest('https://openalex.org/domains/'), display_name: longest('Domain ') },
      },
      published: '2026-08-01',
      arxivId: '2608.20113',
      summary: 'S'.repeat(600),
      doi: `10.1/${'d'.repeat(295)}`,
      landingPageUrl: `https://example.org/${'u'.repeat(1980)}`,
    }],
  ];

  for (const [label, paper] of papers) {
    const payload = buildSavedPaperPayload(paper, savedAt);
    await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'savedPapers', paper.id), payload))
      .catch((error: Error) => assert.fail(`${label} was refused: ${error.message}`));
  }
  const stored = (await getDoc(doc(db, 'users', ALICE, 'savedPapers', 'openalex:W2120490784'))).data();
  assert.equal(stored?.primaryTopic.subfield.id, 'https://openalex.org/subfields/1311');
  assert.equal(stored?.primaryTopic.field.id, 'https://openalex.org/fields/13');
});

test('savedPapers refuses classification evidence outside its bounds', async () => {
  await reset();
  const db = asAlice();
  const valid = buildSavedPaperPayload({
    id: 'openalex:W2120490784', title: 'Cat embryos', primaryTopic: CAT_EMBRYO_TOPIC, categories: ['Cytoplast'],
  }, new Date().toISOString());
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'savedPapers', 'openalex:W2120490784'), valid));

  const refused: [string, Record<string, unknown>][] = [
    ['21 categories', { categories: Array.from({ length: 21 }, (_, index) => `c${index}`) }],
    ['categories as text', { categories: 'cs.AI' }],
    ['a topic with its score', { primaryTopic: CAT_EMBRYO_TOPIC }],
    ['a topic without an id', { primaryTopic: { ...STORED_TOPIC, id: '' } }],
    ['a topic as text', { primaryTopic: 'Genetics' }],
    ['a topic name over 300 characters', { primaryTopic: { ...STORED_TOPIC, display_name: 'x'.repeat(301) } }],
    ['a field with an extra key', { primaryTopic: { ...STORED_TOPIC, field: { ...STORED_TOPIC.field, score: 1 } } }],
    ['a field without a name', { primaryTopic: { ...STORED_TOPIC, field: { id: STORED_TOPIC.field.id } } }],
    ['version zero', { classificationVersion: 0 }],
    ['version as text', { classificationVersion: '1' }],
    ['a fractional version', { classificationVersion: 1.5 }],
  ];
  for (const [label, change] of refused) {
    await assertFails(setDoc(doc(db, 'users', ALICE, 'savedPapers', 'openalex:W2120490784'), { ...valid, ...change }))
      .catch((error: Error) => assert.fail(`${label} was accepted: ${error.message}`));
  }
});

test('another account cannot read or write the classification of a saved paper', async () => {
  await reset();
  const payload = buildSavedPaperPayload({
    id: 'openalex:W2120490784', title: 'Cat embryos', primaryTopic: CAT_EMBRYO_TOPIC,
  }, new Date().toISOString());
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', ALICE, 'savedPapers', 'openalex:W2120490784'), payload);
  });
  for (const db of [asBob(), asGuest()]) {
    await assertFails(getDoc(doc(db, 'users', ALICE, 'savedPapers', 'openalex:W2120490784')));
    await assertFails(setDoc(doc(db, 'users', ALICE, 'savedPapers', 'openalex:W2120490784'), payload));
    await assertFails(setDoc(doc(db, 'users', ALICE, 'savedPapers', 'openalex:W1'), payload));
  }
});

/*
 * Both writers of savedPapers merge into the stored document. One saved
 * before PAP-60 kept only the category its card showed: the tester's AI
 * survey was saved as hep-th. A new save of the same card has to be accepted
 * as an update of that document and leave it reading Artificial Intelligence,
 * as its card does.
 */
test('a save over a savedPapers document from before PAP-60 replaces its category', async () => {
  await reset();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE, 'savedPapers', 'openalex:W4233888153');
  await assertSucceeds(setDoc(ref, {
    title: 'Artificial intelligence', primaryCategory: 'hep-th', savedAt: '2026-10-01T12:00:00.000Z',
  }));

  const card = {
    id: 'openalex:W4233888153',
    title: 'Artificial intelligence',
    primaryTopic: {
      id: 'https://openalex.org/T13904',
      display_name: 'Artificial Intelligence Applications',
      subfield: { id: 'https://openalex.org/subfields/1702', display_name: 'Artificial Intelligence' },
      field: { id: 'https://openalex.org/fields/17', display_name: 'Computer Science' },
      domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
    },
  };
  await assertSucceeds(setDoc(ref, buildSavedPaperPayload(card, new Date().toISOString()), { merge: true }));

  const stored = (await getDoc(ref)).data()!;
  assert.equal(stored.primaryCategory, '');
  assert.equal(areaLabelForPaper(paperLegacyAdapter({ id: card.id, ...stored })), 'Artificial Intelligence');
});

/*
 * PAP-60, D6. When OpenAlex gives a card its topic after the reader liked and
 * saved it, the feed adds `primaryTopic`, and nothing else, to the
 * interaction's copy and to the savedPapers document (keepLateTopics in
 * FeedContext). Here the savedPapers document is one saved before PAP-60,
 * with the category the feed asked for.
 */
test('a topic that arrives late is added to the copies of a liked and saved paper', async () => {
  await reset();
  const db = asAlice();
  const id = 'pmid:1';
  const title = 'In vitro developmental competence of domestic cat embryos after somatic cloning: a preliminary report';
  const { primaryTopic } = storedClassification({ primaryTopic: CAT_EMBRYO_TOPIC });

  const interaction = doc(db, 'users', ALICE, 'interactions', id);
  await assertSucceeds(setDoc(interaction, { liked: true, saved: true, paper: serializeLibraryPaper({ id, title }) }));
  await assertSucceeds(updateDoc(interaction, { 'paper.primaryTopic': primaryTopic }));

  const saved = doc(db, 'users', ALICE, 'savedPapers', id);
  await assertSucceeds(setDoc(saved, { title, primaryCategory: 'physics.bio-ph', savedAt: '2026-10-01T12:00:00.000Z' }));
  await assertSucceeds(updateDoc(saved, { primaryTopic }));

  const copy = (await getDoc(interaction)).data()!.paper;
  assert.equal(copy.title, title, 'the rest of the copy is unchanged');
  assert.equal(areaLabelForPaper(paperLegacyAdapter(copy)), 'Biology');
  assert.equal(areaLabelForPaper(paperLegacyAdapter({ id, ...(await getDoc(saved)).data() })), 'Biology');
});
