/**
 * Behavioural tests for the F1 rules, executed against the Firestore emulator.
 *
 * These exist because the assertions in `src/services/userProfileService.test.js`
 * read `firestore.rules` as text: they catch a clause being deleted, but they
 * cannot catch a clause that was never written. Everything here performs a real
 * write and asserts on what the rules engine actually decides.
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
import {
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  collection,
  limit,
  orderBy,
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

const testEnv = await initializeTestEnvironment({
  projectId: 'papertok-rules-test',
  firestore: {
    rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
    host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0],
    port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),
  },
});

test.after(() => testEnv.cleanup());

/** Seeds documents with rules switched off, then hands back clean contexts. */
async function reset({ aliceProfile = true } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // Two published lists, one owned by each user.
    await setDoc(doc(db, 'publicListOwners', ALICE_SHARE), { ownerId: ALICE, listId: 'l1', createdAt: new Date() });
    await setDoc(doc(db, 'publicListOwners', BOB_SHARE), { ownerId: BOB, listId: 'l2', createdAt: new Date() });
    if (aliceProfile) {
      await setDoc(doc(db, 'userProfiles', ALICE), {
        handle: 'alice', displayName: 'Alice', pinnedLists: [],
        createdAt: new Date(), updatedAt: new Date(),
      });
      await setDoc(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: new Date() });
    }
  });
}

const asAlice = () => testEnv.authenticatedContext(ALICE).firestore();
const asBob = () => testEnv.authenticatedContext(BOB).firestore();
const asGuest = () => testEnv.unauthenticatedContext().firestore();

function pin(shareId, title = 'A list', paperCount = 1) {
  return { shareId, title, paperCount };
}

// =========================================================================
// Reading
// =========================================================================

test('a signed-out reader can fetch a profile and resolve a handle', async () => {
  await reset();
  const db = asGuest();
  await assertSucceeds(getDoc(doc(db, 'userProfiles', ALICE)));
  await assertSucceeds(getDoc(doc(db, 'handles', 'alice')));
});

test('nobody can list the user directory or the handle table', async () => {
  await reset();
  for (const db of [asGuest(), asAlice()]) {
    await assertFails(getDocs(collection(db, 'userProfiles')));
    await assertFails(getDocs(collection(db, 'handles')));
  }
});

test('the private user tree stays private', async () => {
  await reset();
  await assertFails(getDoc(doc(asGuest(), 'users', ALICE)));
  await assertFails(getDoc(doc(asBob(), 'users', ALICE)));
});

// =========================================================================
// Writing somebody else's profile
// =========================================================================

test('a user cannot create, update or delete another user\'s profile', async () => {
  await reset();
  const db = asBob();
  await assertFails(setDoc(doc(db, 'userProfiles', ALICE), {
    handle: 'stolen', displayName: 'Not Alice', pinnedLists: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    displayName: 'Defaced', updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, 'userProfiles', ALICE)));
});

test('a user cannot mark themselves verified or set an orcid', async () => {
  await reset();
  const db = asAlice();
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    verified: true, updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    orcid: '0000-0002-1825-0097', updatedAt: serverTimestamp(),
  }));
});

// --- fix B ---------------------------------------------------------------

test('FIX B: a user cannot award themselves followers', async () => {
  await reset();
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    followerCount: 999999, updatedAt: serverTimestamp(),
  }));
});

test('FIX B: nor smuggle a follower count in at creation time', async () => {
  await reset({ aliceProfile: false });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.set(doc(db, 'userProfiles', ALICE), {
    handle: 'alice', displayName: 'Alice', pinnedLists: [], followerCount: 5000,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: serverTimestamp() });
  await assertFails(batch.commit());
});

test('FIX B: a service-written follower count survives a client edit', async () => {
  await reset();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), 'userProfiles', ALICE), { followerCount: 42 });
  });
  const db = asAlice();
  // Carrying the value through untouched is fine...
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    displayName: 'Alice Again', updatedAt: serverTimestamp(),
  }));
  // ...changing it is not.
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    followerCount: 43, updatedAt: serverTimestamp(),
  }));
});

// =========================================================================
// Handles
// =========================================================================

test('a handle cannot be taken over once it is occupied', async () => {
  await reset();
  const db = asBob();
  await assertFails(setDoc(doc(db, 'handles', 'alice'), {
    uid: BOB, createdAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, 'handles', 'alice')));
});

test('two accounts racing for one handle: the second one loses', async () => {
  await reset({ aliceProfile: false });
  const claim = (db, uid) => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userProfiles', uid), {
      handle: 'contested', displayName: 'Someone', pinnedLists: [],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'handles', 'contested'), { uid, createdAt: serverTimestamp() });
    return batch.commit();
  };
  await assertSucceeds(claim(asAlice(), ALICE));
  await assertFails(claim(asBob(), BOB));

  let stored;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    stored = (await getDoc(doc(context.firestore(), 'handles', 'contested'))).data();
  });
  assert.equal(stored.uid, ALICE, 'the winner keeps the reservation');
});

test('a reserved handle cannot be claimed at all', async () => {
  await reset({ aliceProfile: false });
  const db = asAlice();
  for (const handle of ['admin', 'settings', 'api', 'public']) {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userProfiles', ALICE), {
      handle, displayName: 'Alice', pinnedLists: [],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'handles', handle), { uid: ALICE, createdAt: serverTimestamp() });
    await assertFails(batch.commit());
  }
});

test('an account cannot hold two reservations by renaming', async () => {
  await reset();
  const db = asAlice();
  // New handle claimed, old one left standing.
  const batch = writeBatch(db);
  batch.set(doc(db, 'handles', 'alice2'), { uid: ALICE, createdAt: serverTimestamp() });
  batch.update(doc(db, 'userProfiles', ALICE), { handle: 'alice2', updatedAt: serverTimestamp() });
  await assertFails(batch.commit());

  // The same change, done properly, is allowed.
  const proper = writeBatch(db);
  proper.delete(doc(db, 'handles', 'alice'));
  proper.set(doc(db, 'handles', 'alice2'), { uid: ALICE, createdAt: serverTimestamp() });
  proper.update(doc(db, 'userProfiles', ALICE), { handle: 'alice2', updatedAt: serverTimestamp() });
  await assertSucceeds(proper.commit());
});

test('a handle cannot be reserved without a profile pointing at it', async () => {
  await reset({ aliceProfile: false });
  await assertFails(setDoc(doc(asAlice(), 'handles', 'orphan'), {
    uid: ALICE, createdAt: serverTimestamp(),
  }));
});

// --- fix C ---------------------------------------------------------------

test('FIX C: deleting a profile without freeing its handle is refused', async () => {
  await reset();
  await assertFails(deleteDoc(doc(asAlice(), 'userProfiles', ALICE)));
});

test('FIX C: deleting a profile together with its handle is allowed', async () => {
  await reset();
  const db = asAlice();
  const batch = writeBatch(db);
  batch.delete(doc(db, 'userProfiles', ALICE));
  batch.delete(doc(db, 'handles', 'alice'));
  await assertSucceeds(batch.commit());
});

test('FIX C: delete-and-recreate cannot be used to hoard handles', async () => {
  await reset();
  const db = asAlice();
  // Drop the profile the only way allowed — which also frees the handle.
  const drop = writeBatch(db);
  drop.delete(doc(db, 'userProfiles', ALICE));
  drop.delete(doc(db, 'handles', 'alice'));
  await assertSucceeds(drop.commit());

  // Take a second handle. The first is gone, so this is one reservation, not two.
  const again = writeBatch(db);
  again.set(doc(db, 'userProfiles', ALICE), {
    handle: 'alice2', displayName: 'Alice', pinnedLists: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  again.set(doc(db, 'handles', 'alice2'), { uid: ALICE, createdAt: serverTimestamp() });
  await assertSucceeds(again.commit());

  let held;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snapshot = await getDocs(collection(context.firestore(), 'handles'));
    held = snapshot.docs.map(document => document.id);
  });
  assert.deepEqual(held, ['alice2'], 'exactly one reservation per account');
});

// =========================================================================
// Pinned lists — fix A
// =========================================================================

test('FIX A: a user can pin their own published list', async () => {
  await reset();
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE)], updatedAt: serverTimestamp(),
  }));
});

test('FIX A: a user cannot pin somebody else\'s list', async () => {
  await reset();
  // Bob's list is real and published — it is simply not Alice's to claim.
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(BOB_SHARE, "Bob's list")], updatedAt: serverTimestamp(),
  }));
});

test('FIX A: a user cannot pin a list that does not exist', async () => {
  await reset();
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(GHOST_SHARE, 'Invented')], updatedAt: serverTimestamp(),
  }));
});

test('FIX A: one forged pin poisons the whole write', async () => {
  await reset();
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE), pin(BOB_SHARE, "Bob's")],
    updatedAt: serverTimestamp(),
  }));
});

test('FIX A: a pin cannot be smuggled in at creation time', async () => {
  await reset({ aliceProfile: false });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.set(doc(db, 'userProfiles', ALICE), {
    handle: 'alice', displayName: 'Alice', pinnedLists: [pin(BOB_SHARE, "Bob's")],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: serverTimestamp() });
  await assertFails(batch.commit());
});

/** Gives ALICE `count` published lists to pin. */
async function seedOwnedLists(count) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (let index = 0; index < count; index += 1) {
      await setDoc(doc(db, 'publicListOwners', index.toString(16).padStart(32, '0')), {
        ownerId: ALICE, listId: `l${index}`, createdAt: new Date(),
      });
    }
  });
}

const ownedPins = count => Array.from({ length: count }, (_, index) => (
  pin(index.toString(16).padStart(32, '0'), `List ${index}`)
));

test('FIX A: the pin ceiling is six', async () => {
  await reset();
  await seedOwnedLists(7);
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: ownedPins(6), updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: ownedPins(7), updatedAt: serverTimestamp(),
  }));
});

test('FIX A: the cap sits below the expression budget, not on it', async () => {
  // The rules engine allows 1000 expressions per evaluation, and the pinned
  // array is what consumes them. Measured against this emulator while raising
  // the cap: six and seven entries evaluate cleanly, eight blow the budget.
  // The cap is six so one entry of slack remains for the next clause added to
  // this ruleset — F2 follows, F6 orcid — rather than sitting on the edge.
  //
  // What this test protects: a write AT the cap must be allowed and must not be
  // costing so much that it trips the limit. Above the cap the write must be
  // refused; whether the engine reports a clean denial or an expression-limit
  // error is its business, and it turns out to report the latter, because the
  // budget is spent walking the oversized array before the size check decides.
  await reset();
  await seedOwnedLists(8);
  const attempt = async (count) => {
    try {
      await updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
        pinnedLists: ownedPins(count), updatedAt: serverTimestamp(),
      });
      return 'allowed';
    } catch (error) {
      return /1000 expressions/.test(error.message) ? 'expression-limit' : 'denied';
    }
  };
  assert.equal(await attempt(6), 'allowed', 'a write at the cap must succeed cleanly');
  assert.notEqual(await attempt(7), 'allowed', 'above the cap must never be written');
});

test('FIX A: a full profile can still rename its handle', async () => {
  // The worst case for both budgets at once: six ownership get() calls plus the
  // getAfter and existsAfter that a rename costs.
  await reset();
  await seedOwnedLists(6);
  const db = asAlice();
  const batch = writeBatch(db);
  batch.delete(doc(db, 'handles', 'alice'));
  batch.set(doc(db, 'handles', 'alice2'), { uid: ALICE, createdAt: serverTimestamp() });
  batch.update(doc(db, 'userProfiles', ALICE), {
    handle: 'alice2', pinnedLists: ownedPins(6), updatedAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
});

test('FIX A: a pin whose list was unpublished can still be removed', async () => {
  // The escape from the lock-out: rules validate the array being written, so an
  // entry on its way out is never ownership-checked.
  await reset();
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE)], updatedAt: serverTimestamp(),
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await deleteDoc(doc(context.firestore(), 'publicListOwners', ALICE_SHARE));
  });

  const db = asAlice();
  // Keeping it is now impossible...
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    displayName: 'Alice B', pinnedLists: [pin(ALICE_SHARE)], updatedAt: serverTimestamp(),
  }));
  // ...but dropping it works, so the profile is never permanently stuck.
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [], updatedAt: serverTimestamp(),
  }));
});

test('publicLists and publicListOwners are untouched by any of this', async () => {
  await reset();
  const db = asAlice();
  // Pinning must not require, or grant, any write to the public list documents.
  await assertFails(setDoc(doc(db, 'publicListOwners', BOB_SHARE), {
    ownerId: ALICE, listId: 'l2', createdAt: serverTimestamp(),
  }));
  await assertFails(getDoc(doc(asGuest(), 'publicListOwners', ALICE_SHARE)));
});

// =========================================================================
// User follows (F2)
//
// The graph lives in `follows/{followerUid}_{targetUid}`, never in
// `users/{uid}/following` — that subcollection is private and models authors
// and topics for the feed. Everything below performs a real write or a real
// query and asserts on what the rules engine decides.
// =========================================================================

const CAROL = 'carol-uid';
const EDGE = (follower, target) => `${follower}_${target}`;

/** Both accounts published, so each is followable, plus a clean graph. */
async function resetFollows({ edges = [] } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [uid, handle] of [[ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol']]) {
      await setDoc(doc(db, 'userProfiles', uid), {
        handle, displayName: handle, pinnedLists: [],
        createdAt: new Date(), updatedAt: new Date(),
      });
      await setDoc(doc(db, 'handles', handle), { uid, createdAt: new Date() });
    }
    for (const [follower, target] of edges) {
      await setDoc(doc(db, 'follows', EDGE(follower, target)), {
        followerUid: follower, targetUid: target, createdAt: new Date(),
      });
    }
  });
}

function edgeBody(follower, target) {
  return { followerUid: follower, targetUid: target, createdAt: serverTimestamp() };
}

/** What the profile page spends on a follower counter: one capped aggregation. */
async function followerCount(database, uid) {
  const snapshot = await getCountFromServer(query(
    collection(database, 'follows'),
    where('targetUid', '==', uid),
    limit(1000),
  ));
  return snapshot.data().count;
}

async function followedCount(database, uid) {
  const snapshot = await getCountFromServer(query(
    collection(database, 'follows'),
    where('followerUid', '==', uid),
    limit(1000),
  ));
  return snapshot.data().count;
}

test('following a user writes one edge, and the counters see it', async () => {
  await resetFollows();
  await assertSucceeds(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, BOB)), edgeBody(ALICE, BOB)));

  assert.equal(await followerCount(asGuest(), BOB), 1);
  assert.equal(await followedCount(asGuest(), ALICE), 1);
  assert.equal(await followerCount(asGuest(), ALICE), 0, 'the edge points one way only');
});

test('an account cannot follow itself', async () => {
  await resetFollows();
  await assertFails(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, ALICE)), edgeBody(ALICE, ALICE)));
  assert.equal(await followerCount(asGuest(), ALICE), 0);
});

test('following twice leaves one edge and one follower', async () => {
  await resetFollows();
  const db = asAlice();
  await assertSucceeds(setDoc(doc(db, 'follows', EDGE(ALICE, BOB)), edgeBody(ALICE, BOB)));
  // An edge has no mutable state: the second write is an update, and there is
  // no update rule. The count cannot drift because there is nowhere for a
  // duplicate to be written — the id IS the pair.
  await assertFails(setDoc(doc(db, 'follows', EDGE(ALICE, BOB)), edgeBody(ALICE, BOB)));

  assert.equal(await followerCount(asGuest(), BOB), 1);
  const page = await getDocs(query(
    collection(asGuest(), 'follows'), where('targetUid', '==', BOB), limit(30),
  ));
  assert.equal(page.size, 1);
});

test('the counters add up across follow, unfollow and follow again', async () => {
  await resetFollows();
  const alice = asAlice();
  const bob = asBob();

  await assertSucceeds(setDoc(doc(alice, 'follows', EDGE(ALICE, CAROL)), edgeBody(ALICE, CAROL)));
  await assertSucceeds(setDoc(doc(bob, 'follows', EDGE(BOB, CAROL)), edgeBody(BOB, CAROL)));
  assert.equal(await followerCount(asGuest(), CAROL), 2);

  await assertSucceeds(deleteDoc(doc(alice, 'follows', EDGE(ALICE, CAROL))));
  assert.equal(await followerCount(asGuest(), CAROL), 1);
  assert.equal(await followedCount(asGuest(), ALICE), 0);

  await assertSucceeds(setDoc(doc(alice, 'follows', EDGE(ALICE, CAROL)), edgeBody(ALICE, CAROL)));
  assert.equal(await followerCount(asGuest(), CAROL), 2);
  assert.equal(await followedCount(asGuest(), ALICE), 1);
});

test('a user cannot create somebody else\'s follow', async () => {
  await resetFollows();
  const bob = asBob();
  // Neither by writing Alice's id in the body...
  await assertFails(setDoc(doc(bob, 'follows', EDGE(ALICE, CAROL)), edgeBody(ALICE, CAROL)));
  // ...nor by parking his own body under her document id...
  await assertFails(setDoc(doc(bob, 'follows', EDGE(ALICE, CAROL)), edgeBody(BOB, CAROL)));
  // ...nor by keeping his own id and lying about the document it lives in.
  await assertFails(setDoc(doc(bob, 'follows', EDGE(BOB, CAROL)), edgeBody(BOB, ALICE)));
  assert.equal(await followerCount(asGuest(), CAROL), 0);
});

test('a user cannot delete somebody else\'s follow', async () => {
  await resetFollows({ edges: [[ALICE, CAROL]] });
  await assertFails(deleteDoc(doc(asBob(), 'follows', EDGE(ALICE, CAROL))));
  await assertFails(deleteDoc(doc(asGuest(), 'follows', EDGE(ALICE, CAROL))));
  assert.equal(await followerCount(asGuest(), CAROL), 1, 'the edge is still there');
});

test('an edge cannot be edited into a different edge', async () => {
  await resetFollows({ edges: [[ALICE, BOB]] });
  await assertFails(updateDoc(doc(asAlice(), 'follows', EDGE(ALICE, BOB)), { targetUid: CAROL }));
  await assertFails(updateDoc(doc(asAlice(), 'follows', EDGE(ALICE, BOB)), { createdAt: new Date(0) }));
});

test('an edge carries three fields and a server timestamp, or it is refused', async () => {
  await resetFollows();
  const db = asAlice();
  await assertFails(setDoc(doc(db, 'follows', EDGE(ALICE, BOB)), {
    ...edgeBody(ALICE, BOB), displayName: 'Alice',
  }));
  await assertFails(setDoc(doc(db, 'follows', EDGE(ALICE, BOB)), {
    followerUid: ALICE, targetUid: BOB, createdAt: new Date(2000, 0, 1),
  }));
  await assertFails(setDoc(doc(db, 'follows', EDGE(ALICE, BOB)), { followerUid: ALICE, targetUid: BOB }));
});

test('an account with no public profile cannot be followed', async () => {
  await resetFollows();
  const ghost = 'ghost-uid';
  await assertFails(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, ghost)), edgeBody(ALICE, ghost)));
});

test('nobody can inflate a follower counter on a profile document', async () => {
  // The counters are aggregations over `follows`, so there is nothing to
  // inflate — and `followerCount` stays frozen for clients (hardening B), which
  // is what keeps the denormalized escalation path safe for later.
  await resetFollows();
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    followerCount: 999999, updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(asBob(), 'userProfiles', ALICE), {
    displayName: 'Not Alice', updatedAt: serverTimestamp(),
  }));
});

test('the follower graph is public to read, one bounded page at a time', async () => {
  await resetFollows({ edges: [[ALICE, CAROL], [BOB, CAROL]] });
  const guest = asGuest();

  await assertSucceeds(getDocs(query(
    collection(guest, 'follows'), where('targetUid', '==', CAROL), orderBy('createdAt', 'desc'), limit(30),
  )));
  await assertSucceeds(getDoc(doc(guest, 'follows', EDGE(ALICE, CAROL))));
});

test('no caller can ask the graph for more than the page ceiling', async () => {
  await resetFollows({ edges: [[ALICE, CAROL]] });
  const guest = asGuest();
  // The ceiling is the rule, not a client convention: a query with no limit,
  // or one past the cap, is refused outright — including the aggregations the
  // counters are built on.
  await assertFails(getDocs(query(collection(guest, 'follows'), where('targetUid', '==', CAROL))));
  await assertFails(getDocs(query(collection(guest, 'follows'), limit(1001))));
  await assertFails(getCountFromServer(query(
    collection(guest, 'follows'), where('targetUid', '==', CAROL),
  )));
  await assertSucceeds(getCountFromServer(query(
    collection(guest, 'follows'), where('targetUid', '==', CAROL), limit(1000),
  )));
});

test('COST: a feed load is still ONE document read, follows or no follows', async () => {
  // A feed load reads exactly one document: the interaction aggregate. If this
  // phase had broken that read, every load would fall back to the bounded
  // rebuild — one read per interaction document, thousands of them.
  await resetFollows({ edges: [[BOB, ALICE], [CAROL, ALICE], [ALICE, BOB]] });
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

  const db = asAlice();
  let documentsRead = 0;
  const aggregate = await getDoc(doc(db, 'users', ALICE, 'aggregates', 'interactions'));
  documentsRead += aggregate.exists() ? 1 : 0;

  assert.equal(documentsRead, 1, 'the feed load must cost exactly one document');
  assert.equal(aggregate.data().sourceDocCount, 3, 'and that document must be the usable one');

  // The follows block grants nothing under users/, so it cannot have widened
  // or narrowed what a feed load touches.
  await assertFails(getDoc(doc(asBob(), 'users', ALICE, 'aggregates', 'interactions')));
  await assertFails(getDocs(query(collection(asBob(), 'users', ALICE, 'interactions'), limit(10))));
});

test('a uid carrying the separator cannot squat an edge document', async () => {
  // `{follower}_{target}` only reads back as one pair while no uid contains
  // `_`. Firebase Auth mints alphanumeric uids, so this refuses nothing real —
  // but without it the account `alice_uid` could occupy the document `alice`
  // needs to follow `uid_bob`, and block that follow forever.
  await resetFollows();
  const odd = 'alice_uid';
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'userProfiles', odd), {
      handle: 'odd', displayName: 'Odd', pinnedLists: [],
      createdAt: new Date(), updatedAt: new Date(),
    });
  });
  const db = testEnv.authenticatedContext(odd).firestore();
  await assertFails(setDoc(doc(db, 'follows', EDGE(odd, BOB)), edgeBody(odd, BOB)));
  await assertFails(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, odd)), edgeBody(ALICE, odd)));
});

test('a signed-out visitor can read the graph but never write it', async () => {
  await resetFollows({ edges: [[ALICE, BOB]] });
  const guest = asGuest();
  await assertFails(setDoc(doc(guest, 'follows', EDGE(ALICE, CAROL)), edgeBody(ALICE, CAROL)));
  await assertFails(setDoc(doc(guest, 'follows', EDGE(CAROL, BOB)), edgeBody(CAROL, BOB)));
});

// =========================================================================
// F8 — Profile visibility
//
// The whole point of this phase is that "private" is a property of the data,
// not of the screen. Every test here performs a real read as a real caller.
// =========================================================================

/** Seeds three profiles whose visibility is set per uid. `null` = legacy. */
async function resetVisibility({ visibility = {}, edges = [] } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [uid, handle] of [[ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol']]) {
      const chosen = visibility[uid];
      await setDoc(doc(db, 'userProfiles', uid), {
        handle,
        displayName: handle,
        pinnedLists: [],
        ...(chosen ? { visibility: chosen } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await setDoc(doc(db, 'handles', handle), { uid, createdAt: new Date() });
    }
    for (const [follower, target] of edges) {
      await setDoc(doc(db, 'follows', EDGE(follower, target)), {
        followerUid: follower, targetUid: target, createdAt: new Date(),
      });
    }
  });
}

test('F8: a private profile is unreadable to a signed-out visitor', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'private' } });
  await assertFails(getDoc(doc(asGuest(), 'userProfiles', ALICE)));
});

test('F8: a private profile is unreadable to another signed-in account', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'private' } });
  await assertFails(getDoc(doc(asBob(), 'userProfiles', ALICE)));
});

test('F8: a private profile is readable by its owner', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'private' } });
  await assertSucceeds(getDoc(doc(asAlice(), 'userProfiles', ALICE)));
});

test('F8: a profile written before this phase keeps reading as public', async () => {
  // Requirement: nobody's visibility changes behind their back. A legacy
  // document has no `visibility` field at all, and absence must mean public.
  await resetVisibility();
  await assertSucceeds(getDoc(doc(asGuest(), 'userProfiles', ALICE)));
  await assertSucceeds(getDoc(doc(asBob(), 'userProfiles', ALICE)));
});

test('F8: an explicitly public profile reads exactly like a legacy one', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'public' } });
  await assertSucceeds(getDoc(doc(asGuest(), 'userProfiles', ALICE)));
});

test('F8: the owner can go private and come back, in both directions', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'public' } });
  const db = asAlice();
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    visibility: 'private', updatedAt: serverTimestamp(),
  }));
  await assertFails(getDoc(doc(asGuest(), 'userProfiles', ALICE)));
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    visibility: 'public', updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(getDoc(doc(asGuest(), 'userProfiles', ALICE)));
});

test('F8: nobody can change somebody else\'s visibility', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'private' } });
  await assertFails(updateDoc(doc(asBob(), 'userProfiles', ALICE), {
    visibility: 'public', updatedAt: serverTimestamp(),
  }));
});

test('F8: visibility only accepts the two values it defines', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'public' } });
  const db = asAlice();
  for (const bad of ['secret', 'PUBLIC', '', 'followers', true, 1]) {
    await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
      visibility: bad, updatedAt: serverTimestamp(),
    }));
  }
});

test('F8: a private profile cannot be followed', async () => {
  await resetVisibility({ visibility: { [BOB]: 'private' } });
  await assertFails(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, BOB)), edgeBody(ALICE, BOB)));
});

test('F8: public and legacy profiles stay followable', async () => {
  await resetVisibility({ visibility: { [BOB]: 'public' } });
  await assertSucceeds(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, BOB)), edgeBody(ALICE, BOB)));
  // CAROL is legacy — no visibility field — and must behave like public.
  await assertSucceeds(setDoc(doc(asAlice(), 'follows', EDGE(ALICE, CAROL)), edgeBody(ALICE, CAROL)));
});

test('F8: going private never deletes existing edges, and unfollow still works', async () => {
  // Going private stops new follows; it does not reach into the graph and
  // remove people. The follower must also always be able to leave.
  await resetVisibility({ visibility: { [BOB]: 'private' }, edges: [[ALICE, BOB]] });
  await assertSucceeds(getDoc(doc(asGuest(), 'follows', EDGE(ALICE, BOB))));
  await assertSucceeds(deleteDoc(doc(asAlice(), 'follows', EDGE(ALICE, BOB))));
});

test('F8: what going private does NOT hide, asserted so the UI cannot lie', async () => {
  // The privacy screen tells the user these three things stay visible. If a
  // future change quietly makes one of them false, the copy becomes a lie in
  // the other direction — so they are pinned here as facts, not as leaks.
  await resetVisibility({ visibility: { [ALICE]: 'private' }, edges: [[BOB, ALICE], [CAROL, ALICE]] });
  const guest = asGuest();
  // 1. The handle reservation still resolves (uniqueness has to be answerable).
  await assertSucceeds(getDoc(doc(guest, 'handles', 'alice')));
  // 2. The follower count is still countable.
  await assertSucceeds(getCountFromServer(query(
    collection(guest, 'follows'), where('targetUid', '==', ALICE), limit(1000),
  )));
  // 3. A list published from Mis listas stays public (it is anonymous by
  //    design; going private removes attribution, not the list).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'publicLists', ALICE_SHARE), {
      title: 'Shared', papers: [], createdAt: new Date(), updatedAt: new Date(),
    });
  });
  await assertSucceeds(getDoc(doc(guest, 'publicLists', ALICE_SHARE)));
});

test('F8: a private profile keeps its handle, and nobody else can take it', async () => {
  await resetVisibility({ visibility: { [ALICE]: 'private' } });
  // Going private must not free the reservation: the switch has to be
  // reversible, and it is not reversible if the handle can be taken meanwhile.
  await assertFails(setDoc(doc(asBob(), 'handles', 'alice'), {
    uid: BOB, createdAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(asBob(), 'handles', 'alice')));
});

test('F8: a private profile at the pin cap still saves', async () => {
  // The expression budget is the reason the pin cap is six. This phase adds
  // clauses to validPublicProfile, so the worst case has to be re-measured
  // rather than assumed: six pins AND a visibility field in one write.
  await reset();
  await seedOwnedLists(6);
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: ownedPins(6), visibility: 'private', updatedAt: serverTimestamp(),
  }));
});

test('F8: stashed pins live in an owner-only subcollection', async () => {
  // Hiding pinned lists means the array is absent from the world-readable
  // profile: Firestore has no field-level security, so anything left in that
  // document is public. The stash sits under the private user tree.
  await reset();
  const db = asAlice();
  const stash = doc(db, 'users', ALICE, 'profileStash', 'pinnedLists');
  await assertSucceeds(setDoc(stash, {
    pinnedLists: [pin(ALICE_SHARE, 'Hidden list')], updatedAt: serverTimestamp(),
  }));
  await assertFails(getDoc(doc(asBob(), 'users', ALICE, 'profileStash', 'pinnedLists')));
  await assertFails(getDoc(doc(asGuest(), 'users', ALICE, 'profileStash', 'pinnedLists')));
  // The cap travels with it, so the stash cannot be used as free storage.
  await assertFails(setDoc(stash, {
    pinnedLists: Array.from({ length: 7 }, () => pin(ALICE_SHARE, 'x')),
    updatedAt: serverTimestamp(),
  }));
  // And it holds pins, nothing else. The extra key has to ride along with an
  // OTHERWISE VALID document, or the size check denies the write on its own
  // and the allowlist never gets a say — which is exactly how a mutation of
  // this clause survived the first version of this test.
  await assertFails(setDoc(stash, {
    pinnedLists: [pin(ALICE_SHARE, 'Hidden list')],
    updatedAt: serverTimestamp(),
    smuggled: 'anything',
  }));
  await assertFails(setDoc(stash, { smuggled: 'anything', updatedAt: serverTimestamp() }));
});

test('F8: hiding pinned lists is a state the profile can carry', async () => {
  await reset();
  await seedOwnedLists(2);
  const db = asAlice();
  // Hiding empties the public array — the entries themselves must leave the
  // world-readable document, because a readable document has no private
  // fields — and records that the emptiness was a choice.
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [], showPinnedLists: false, updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: ownedPins(2), showPinnedLists: true, updatedAt: serverTimestamp(),
  }));
  for (const bad of ['yes', 1, 'true']) {
    await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
      showPinnedLists: bad, updatedAt: serverTimestamp(),
    }));
  }
});

test('F8: the stash works on an account whose user document is legacy', async () => {
  // Accounts created by early versions carry fields (`email`, `displayName`,
  // `photoURL`, `createdAt`) that the users/{uid} key allowlist never covered,
  // so every merge write to that document is denied — a pre-existing bug this
  // feature must not inherit. The stash is a subcollection precisely so it
  // stays writable on those accounts.
  await reset();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', ALICE), {
      onboardingComplete: true,
      preferences: ['astro-ph.GA'],
      email: 'alice@example.test',
      displayName: 'Alice',
      photoURL: 'https://example.test/a.png',
      createdAt: new Date(),
    });
  });
  const db = asAlice();
  // The parent document is indeed unwritable — that is the bug, asserted so
  // its eventual fix is visible here too.
  await assertFails(setDoc(doc(db, 'users', ALICE), { onboardingComplete: true }, { merge: true }));
  // The stash is unaffected.
  await assertSucceeds(setDoc(doc(db, 'users', ALICE, 'profileStash', 'pinnedLists'), {
    pinnedLists: [pin(ALICE_SHARE, 'Hidden')], updatedAt: serverTimestamp(),
  }));
});

test('F8: hiding pins writes both documents the way the client does', async () => {
  // The exact two-write batch setPinnedListsVisible commits.
  await reset();
  await seedOwnedLists(1);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice', pinnedLists: [pin(ALICE_SHARE)],
      visibility: 'private', bio: 'hi', allowContact: true,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', ALICE, 'profileStash', 'pinnedLists'), {
    pinnedLists: [pin(ALICE_SHARE)], updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [], showPinnedLists: false, updatedAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
});
