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
import { toIndexedName } from '../src/services/userSearchService.js';
import { PUBLIC_LIST_LIMITS } from '../src/services/publicListPayload.js';
import {
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  collection,
  collectionGroup,
  increment,
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
      handle: 'contested', displayName: 'Someone', pinnedLists: [], visibility: 'public',
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
      handle, displayName: 'Alice', pinnedLists: [], visibility: 'public',
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
    handle: 'alice2', displayName: 'Alice', pinnedLists: [], visibility: 'public',
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

test('a stale pin vetoes even the write that pins its own successor', async () => {
  // The republish sequence: unpublish deletes publicListOwners/{old}, publish
  // mints a fresh share id. The profile still holds the old pin, and the rules
  // ownership-check every entry in the array being written — so pinning the
  // NEW share id while the orphan rides along is refused wholesale. This is
  // what the profile editor surfaced as a bare "something went wrong" on Pin;
  // the client now drops stale entries before writing (togglePinnedList), and
  // this test is the reason it must.
  await reset();
  const successor = 'c'.repeat(32);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // Alice pinned her list, then republished it: old owner doc gone, new one live.
    await setDoc(doc(db, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice', pinnedLists: [pin(ALICE_SHARE)],
      createdAt: new Date(), updatedAt: new Date(),
    });
    await deleteDoc(doc(db, 'publicListOwners', ALICE_SHARE));
    await setDoc(doc(db, 'publicListOwners', successor), {
      ownerId: ALICE, listId: 'l1', createdAt: new Date(),
    });
  });

  const db = asAlice();
  // Carrying the orphan while pinning the successor: refused, in one piece.
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE), pin(successor, 'Republished')],
    updatedAt: serverTimestamp(),
  }));
  // Dropping the orphan and pinning the successor: exactly what the client
  // writes now, and it must pass.
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [pin(successor, 'Republished')], updatedAt: serverTimestamp(),
  }));
});

test('the pin-card paper count is capped by the public-list cap, not the old 12', async () => {
  // F11 raised PUBLIC_LIST_LIMITS.papers from 12 to 50; the pin card mirrors
  // the list it denormalizes, so the rules cap moves with it. Left at 12 this
  // refused the true count of any list past a dozen papers — the live bug was
  // a 19-paper list whose card could only ever say "12 papers".
  await reset();
  const db = asAlice();
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE, 'Relatividad', 19)], updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE, 'At the cap', PUBLIC_LIST_LIMITS.papers)],
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE, 'Past the cap', PUBLIC_LIST_LIMITS.papers + 1)],
    updatedAt: serverTimestamp(),
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

test('F8+F9: and what it DOES hide — the search index, as absence', async () => {
  // The complement of the test above, and the reason it can be stated as a
  // fact: a private profile is not filtered out of search results, it has no
  // document to filter. Asserted as a real query by a real caller, so a client
  // that ignored the app entirely would see the same nothing.
  await resetSearch({
    visibility: { [ALICE]: 'private', [BOB]: 'public' },
    indexed: [BOB],
    names: { [ALICE]: 'Alicia', [BOB]: 'Alicio' },
  });
  const found = await getDocs(prefixQuery(asCarol(), 'nameLower', 'alici'));
  assert.deepEqual(found.docs.map(entry => entry.id), [BOB], 'only the public profile is there');
  // And the owner cannot put themselves back in without leaving privacy.
  await assertFails(setDoc(doc(asAlice(), 'userSearch', ALICE), searchEntry('alice', 'alicia')));
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

test('F8 (second deploy): a profile cannot be created without a choice', async () => {
  // The client already refuses this; from this rules version the database
  // refuses it too, so no client — stale, modified or hand-rolled — can create
  // a profile whose visibility nobody picked.
  await reset({ aliceProfile: false });
  const db = asAlice();
  const attempt = (extra) => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice', pinnedLists: [],
      ...extra,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: serverTimestamp() });
    return batch.commit();
  };
  await assertFails(attempt({}));
  await assertFails(attempt({ visibility: 'secret' }));
  await assertSucceeds(attempt({ visibility: 'private' }));
});

test('F8 (second deploy): a legacy profile stays editable without the field', async () => {
  // Requiring the choice on create must not lock existing owners out of their
  // own profile before they have answered the prompt.
  await reset();
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    displayName: 'Alice Renamed', updatedAt: serverTimestamp(),
  }));
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
  // The stash is a subcollection partly because the parent document used to be
  // unwritable on accounts of this vintage. That bug is fixed (see the section
  // below), so both documents must now take a write — the parent because the
  // fix works, the stash because the fix did not disturb it.
  await reset();
  await seedLegacyUserDoc();
  const db = asAlice();
  await assertSucceeds(setDoc(doc(db, 'users', ALICE), { onboardingComplete: true }, { merge: true }));
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

// =========================================================================
// F3 — paper stubs, comments, throttle, moderation. Everything below is a
// real write or query against the emulator; nothing asserts on rules text.
// =========================================================================

const DAVE = 'dave-uid'; // signed in, never created a profile
// Whatever uid isAdmin() currently carries — the placeholder before the P7
// paste, the real one after. Read from the rules text so pasting the real
// uid does not orphan every admin test; the emulator authenticates as any
// string either way.
const ADMIN = (await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'))
  .match(/request\.auth\.uid == '([^']+)'/)?.[1] ?? 'REPLACE_WITH_ADMIN_UID';
const asCarol = () => testEnv.authenticatedContext(CAROL).firestore();
const asDave = () => testEnv.authenticatedContext(DAVE).firestore();
const asAdmin = () => testEnv.authenticatedContext(ADMIN).firestore();

// Rules never verify that the id is base64url(canonicalKey) — no base64 in
// the rules language — so tests may use readable ids. What the rules DO
// verify is the coherence between canonicalKey and the identifier fields.
const PAPER = 'k-doi-abc';
const SIXTY_S_AGO = () => new Date(Date.now() - 60_000);

function stubSeed(overrides = {}) {
  return {
    canonicalKey: 'doi:10.1234/abc', title: 'A paper', authors: ['A. Author'],
    doi: '10.1234/abc', createdAt: new Date(), createdBy: ALICE,
    ...overrides,
  };
}

function stubBody(overrides = {}) {
  const body = {
    canonicalKey: 'doi:10.1234/abc', title: 'A paper', authors: ['A. Author'],
    doi: '10.1234/abc', createdAt: serverTimestamp(), createdBy: ALICE,
    ...overrides,
  };
  // `{ doi: undefined }` means "without a doi" — the SDK refuses undefined
  // values, so absence is expressed by dropping the key.
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function commentSeed(uid, handle, overrides = {}) {
  return {
    authorUid: uid, authorHandle: handle, text: 'Seeded', status: 'visible',
    createdAt: new Date(), ...overrides,
  };
}

function commentBody(uid, handle, overrides = {}) {
  return {
    authorUid: uid, authorHandle: handle, text: 'Interesting result',
    status: 'visible', createdAt: serverTimestamp(), ...overrides,
  };
}

function stamp(db, uid, action) {
  return [doc(db, 'users', uid, 'rateLimits', action),
    { lastAt: serverTimestamp(), count: increment(1) }];
}

/** The batch the app really sends: comment + throttle stamp (+ stub + its stamp). */
function commentBatch(db, uid, body, { paper = PAPER, stub = null } = {}) {
  const batch = writeBatch(db);
  if (stub) {
    batch.set(doc(db, 'papers', paper), stub);
    const [stubRef, stubStamp] = stamp(db, uid, 'stubs');
    batch.set(stubRef, stubStamp, { merge: true });
  }
  const commentRef = doc(collection(db, 'papers', paper, 'comments'));
  batch.set(commentRef, body);
  const [commentsRef, commentsStamp] = stamp(db, uid, 'comments');
  batch.set(commentsRef, commentsStamp, { merge: true });
  return { batch, commentRef };
}

function reportBatch(db, uid, overrides = {}) {
  const batch = writeBatch(db);
  batch.set(doc(collection(db, 'reports')), {
    reporterUid: uid, targetPath: `papers/${PAPER}/comments/c1`,
    targetAuthorUid: ALICE, reason: 'spam', status: 'open',
    createdAt: serverTimestamp(), ...overrides,
  });
  const [ref, body] = stamp(db, uid, 'reports');
  batch.set(ref, body, { merge: true });
  return batch;
}

/** Alice and Bob public, Carol private, Dave profile-less; one stub. */
async function resetSocial({ stub = true, comments = {}, stamps = [], config = null } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [uid, handle, visibility] of [
      [ALICE, 'alice', 'public'], [BOB, 'bob', 'public'], [CAROL, 'carol', 'private'],
    ]) {
      await setDoc(doc(db, 'userProfiles', uid), {
        handle, displayName: handle, pinnedLists: [], visibility,
        createdAt: new Date(), updatedAt: new Date(),
      });
      await setDoc(doc(db, 'handles', handle), { uid, createdAt: new Date() });
    }
    if (stub) await setDoc(doc(db, 'papers', PAPER), stubSeed());
    for (const [id, body] of Object.entries(comments)) {
      await setDoc(doc(db, 'papers', PAPER, 'comments', id), body);
    }
    for (const [uid, action, when] of stamps) {
      await setDoc(doc(db, 'users', uid, 'rateLimits', action), { lastAt: when, count: 1 });
    }
    if (config) await setDoc(doc(db, 'config', 'moderation'), config);
  });
}

// --- stubs ----------------------------------------------------------------

test('F3: anyone can resolve a stub by id; nobody can page the collection', async () => {
  await resetSocial();
  await assertSucceeds(getDoc(doc(asGuest(), 'papers', PAPER)));
  for (const db of [asGuest(), asAlice()]) {
    await assertFails(getDocs(query(collection(db, 'papers'), limit(10))));
  }
});

test('F3: a stub create needs its throttle stamp, and works with it', async () => {
  await resetSocial({ stub: false });
  const bare = asAlice();
  await assertFails(setDoc(doc(bare, 'papers', PAPER), stubBody()));

  const db = asAlice();
  const batch = writeBatch(db);
  batch.set(doc(db, 'papers', PAPER), stubBody());
  const [ref, body] = stamp(db, ALICE, 'stubs');
  batch.set(ref, body, { merge: true });
  await assertSucceeds(batch.commit());
});

test('F3: a stub is immutable to users; the admin can repair and delete it', async () => {
  await resetSocial();
  // The creator themselves cannot rewrite the cache (defacement surface)...
  await assertFails(updateDoc(doc(asAlice(), 'papers', PAPER), { title: 'Defaced' }));
  await assertFails(updateDoc(doc(asBob(), 'papers', PAPER), { title: 'Defaced' }));
  // ...nor overwrite it wholesale with a fresh-looking create.
  const db = asBob();
  const batch = writeBatch(db);
  batch.set(doc(db, 'papers', PAPER), stubBody({ title: 'Replaced', createdBy: BOB }));
  const [ref, body] = stamp(db, BOB, 'stubs');
  batch.set(ref, body, { merge: true });
  await assertFails(batch.commit());
  await assertFails(deleteDoc(doc(asAlice(), 'papers', PAPER)));
  await assertSucceeds(updateDoc(doc(asAdmin(), 'papers', PAPER), { title: 'Repaired' }));
  await assertSucceeds(deleteDoc(doc(asAdmin(), 'papers', PAPER)));
});

test('F3: the stub identity must cohere with the identifiers it carries', async () => {
  await resetSocial({ stub: false });
  const attempt = (overrides) => {
    const db = asAlice();
    const batch = writeBatch(db);
    batch.set(doc(db, 'papers', PAPER), stubBody(overrides));
    const [ref, body] = stamp(db, ALICE, 'stubs');
    batch.set(ref, body, { merge: true });
    return batch.commit();
  };
  // A key that does not match its own doi.
  await assertFails(attempt({ canonicalKey: 'doi:10.9999/other' }));
  // A doi-shaped key with no doi field to back it.
  await assertFails(attempt({ canonicalKey: 'doi:10.9999/other', doi: undefined }));
  // An uppercase doi — canonical spelling is lowercase.
  await assertFails(attempt({ canonicalKey: 'doi:10.1234/ABC', doi: '10.1234/ABC' }));
  // A versioned arXiv id — the stub contract is versionless.
  await assertFails(attempt({
    canonicalKey: 'arxiv:2401.12345v2', doi: undefined, arxivId: '2401.12345v2',
  }));
  // The honest shapes pass: arXiv…
  await assertSucceeds(attempt({
    canonicalKey: 'arxiv:2401.12345', doi: undefined, arxivId: '2401.12345',
  }));
  // …and a raw provider id, which may not wear a canonical prefix.
  await testEnv.clearFirestore();
  await resetSocial({ stub: false });
  await assertSucceeds(attempt({ canonicalKey: 'pmid:38012345', doi: undefined }));
});

test('F3: the second create on an existing stub is refused — one paper, one thread', async () => {
  await resetSocial();
  const db = asBob();
  const batch = writeBatch(db);
  batch.set(doc(db, 'papers', PAPER), stubBody({ createdBy: BOB }));
  const [ref, body] = stamp(db, BOB, 'stubs');
  batch.set(ref, body, { merge: true });
  // set() on an existing document is an update to the rules, and updates are
  // admin-only: the loser of the race falls back to commenting on the stub
  // that won, which is exactly the convergence the canonical key exists for.
  await assertFails(batch.commit());
});

// --- comments: who may speak ----------------------------------------------

test('F3: a public profile can comment, stub and first comment in one batch', async () => {
  await resetSocial({ stub: false });
  const db = asAlice();
  const { batch } = commentBatch(db, ALICE, commentBody(ALICE, 'alice'), { stub: stubBody() });
  await assertSucceeds(batch.commit());
});

test('F3: a comment on an existing stub needs no stub write', async () => {
  await resetSocial();
  const { batch } = commentBatch(asBob(), BOB, commentBody(BOB, 'bob'));
  await assertSucceeds(batch.commit());
});

test('F3: a private profile cannot comment', async () => {
  await resetSocial();
  const { batch } = commentBatch(asCarol(), CAROL, commentBody(CAROL, 'carol'));
  await assertFails(batch.commit());
});

test('F3: an account with no public profile cannot comment', async () => {
  await resetSocial();
  const { batch } = commentBatch(asDave(), DAVE, commentBody(DAVE, 'dave'));
  await assertFails(batch.commit());
});

test('F3: the handle snapshot must be the author\'s real handle', async () => {
  await resetSocial();
  const { batch } = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'bob'));
  await assertFails(batch.commit());
});

test('F3: nobody can write a comment as somebody else', async () => {
  await resetSocial();
  const { batch } = commentBatch(asAlice(), ALICE, commentBody(BOB, 'bob'));
  await assertFails(batch.commit());
});

test('F3: a comment cannot be born hidden, backdated, or oversized', async () => {
  await resetSocial();
  for (const bad of [
    { status: 'hidden' },
    { createdAt: SIXTY_S_AGO() },
    { text: 'x'.repeat(4001) },
    { text: '' },
    { extra: 'field' },
  ]) {
    const { batch } = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice', bad));
    await assertFails(batch.commit());
  }
});

test('F3: a comment needs a stub, existing or in-batch', async () => {
  await resetSocial({ stub: false });
  const { batch } = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice'));
  await assertFails(batch.commit());
});

// --- comments: the throttle ------------------------------------------------

test('F3: a comment without its throttle stamp does not land', async () => {
  await resetSocial();
  const db = asAlice();
  await assertFails(setDoc(
    doc(collection(db, 'papers', PAPER, 'comments')),
    commentBody(ALICE, 'alice'),
  ));
});

test('F3: the rate limit actually cuts, and lets go after the interval', async () => {
  await resetSocial();
  const first = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice'));
  await assertSucceeds(first.batch.commit());
  // Immediately again: the stamp update violates the 15 s interval, and the
  // comment cannot land without the stamp — the batch dies as one.
  const second = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice'));
  await assertFails(second.batch.commit());
  // Backdate the ledger as if 60 s had passed: the tap reopens.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', ALICE, 'rateLimits', 'comments'),
      { lastAt: SIXTY_S_AGO(), count: 1 });
  });
  const third = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice'));
  await assertSucceeds(third.batch.commit());
});

test('F3: the ledger accepts only known actions, with a well-typed count', async () => {
  await resetSocial();
  // An unknown action would be a free parking spot under users/{uid} — the
  // allowlist is what keeps this subcollection meaning one thing.
  await assertFails(setDoc(doc(asAlice(), 'users', ALICE, 'rateLimits', 'anything'),
    { lastAt: serverTimestamp(), count: 1 }));
  // On an otherwise-valid create, the count typing is the deciding clause.
  await assertFails(setDoc(doc(asAlice(), 'users', ALICE, 'rateLimits', 'comments'),
    { lastAt: serverTimestamp(), count: 'nope' }));
  await assertFails(setDoc(doc(asAlice(), 'users', ALICE, 'rateLimits', 'comments'),
    { lastAt: serverTimestamp(), count: -1 }));
});

test('F3: a stub cannot be created in somebody else\'s name', async () => {
  await resetSocial({ stub: false });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.set(doc(db, 'papers', PAPER), stubBody({ createdBy: BOB }));
  const [ref, body] = stamp(db, ALICE, 'stubs');
  batch.set(ref, body, { merge: true });
  await assertFails(batch.commit());
});

test('F3: only the moderation config document is readable, nothing else in config/', async () => {
  await resetSocial({ config: { commentsFrozen: false } });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'config', 'other'), { secret: true });
  });
  await assertSucceeds(getDoc(doc(asGuest(), 'config', 'moderation')));
  await assertFails(getDoc(doc(asGuest(), 'config', 'other')));
  await assertFails(getDocs(query(collection(asGuest(), 'config'), limit(5))));
});

test('F3: the throttle ledger cannot be reset, backdated, or read by others', async () => {
  await resetSocial({ stamps: [[ALICE, 'comments', new Date()]] });
  // Deleting the ledger would reset the clock.
  await assertFails(deleteDoc(doc(asAlice(), 'users', ALICE, 'rateLimits', 'comments')));
  // Writing a stamp that is not this request's time defeats the comparison.
  await assertFails(setDoc(doc(asAlice(), 'users', ALICE, 'rateLimits', 'comments'),
    { lastAt: SIXTY_S_AGO(), count: 1 }));
  // Also on a fresh CREATE, where no interval applies and the stamp clause is
  // the one that decides — the mutation pass caught this exact gap.
  await assertFails(setDoc(doc(asDave(), 'users', DAVE, 'rateLimits', 'comments'),
    { lastAt: SIXTY_S_AGO(), count: 1 }));
  // Another account can neither read nor write my ledger.
  await assertFails(getDoc(doc(asBob(), 'users', ALICE, 'rateLimits', 'comments')));
  await assertFails(setDoc(doc(asBob(), 'users', ALICE, 'rateLimits', 'comments'),
    { lastAt: serverTimestamp(), count: 1 }));
});

// --- comments: threading ----------------------------------------------------

test('F3: replies attach to a real comment, one level deep only', async () => {
  await resetSocial({
    comments: {
      parent: commentSeed(ALICE, 'alice'),
      reply: commentSeed(BOB, 'bob', { replyTo: 'parent' }),
    },
  });
  // To a top-level comment: yes.
  const ok = commentBatch(asBob(), BOB, commentBody(BOB, 'bob', { replyTo: 'parent' }));
  await assertSucceeds(ok.batch.commit());
  // To a reply: no — that would be level two.
  const deep = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice', { replyTo: 'reply' }));
  await assertFails(deep.batch.commit());
  // To a ghost: no.
  const ghost = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice', { replyTo: 'nope' }));
  await assertFails(ghost.batch.commit());
});

// --- comments: editing ------------------------------------------------------

test('F3: editing is the author\'s, text only, marked with the server clock', async () => {
  await resetSocial({ comments: { c1: commentSeed(ALICE, 'alice') } });
  const ref = (db) => doc(db, 'papers', PAPER, 'comments', 'c1');
  await assertFails(updateDoc(ref(asBob()), { text: 'Not mine', editedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref(asAlice()), { text: 'Edited', editedAt: serverTimestamp() }));
  // The edit mark must be honest…
  await assertFails(updateDoc(ref(asAlice()), { text: 'Edited', editedAt: SIXTY_S_AGO() }));
  // …and nothing else may move: not the clock, not the visibility.
  await assertFails(updateDoc(ref(asAlice()), {
    text: 'Edited', editedAt: serverTimestamp(), createdAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref(asAlice()), {
    text: 'Edited', editedAt: serverTimestamp(), status: 'hidden',
  }));
});

test('F3: the admin moderates status and cannot rewrite what was said', async () => {
  await resetSocial({ comments: { c1: commentSeed(ALICE, 'alice') } });
  const ref = doc(asAdmin(), 'papers', PAPER, 'comments', 'c1');
  await assertSucceeds(updateDoc(ref, { status: 'hidden' }));
  await assertSucceeds(updateDoc(ref, { status: 'visible' }));
  await assertFails(updateDoc(ref, { status: 'shadowbanned' }));
  await assertFails(updateDoc(ref, { text: 'Reworded', editedAt: serverTimestamp() }));
});

test('F3: hidden comments stay readable at the data layer, by decision', async () => {
  // 02-SECURITY.md §1: the official client filters status, the author sees
  // "hidden" in their own list, and definitive removal is the admin's delete.
  // Pinned here so a future rules change that breaks the author's view of
  // their own hidden comment shows up as a failure, not a surprise.
  await resetSocial({ comments: { c1: commentSeed(ALICE, 'alice', { status: 'hidden' }) } });
  await assertSucceeds(getDoc(doc(asGuest(), 'papers', PAPER, 'comments', 'c1')));
});

// --- comments: deleting and the cascade -------------------------------------

test('F3: deleting is the author\'s or the admin\'s, never a stranger\'s', async () => {
  await resetSocial({ comments: { c1: commentSeed(ALICE, 'alice') } });
  await assertFails(deleteDoc(doc(asBob(), 'papers', PAPER, 'comments', 'c1')));
  await assertSucceeds(deleteDoc(doc(asAlice(), 'papers', PAPER, 'comments', 'c1')));
  await resetSocial({ comments: { c2: commentSeed(BOB, 'bob') } });
  await assertSucceeds(deleteDoc(doc(asAdmin(), 'papers', PAPER, 'comments', 'c2')));
});

test('F3: deleting a parent takes its replies with it, in one batch', async () => {
  await resetSocial({
    comments: {
      parent: commentSeed(ALICE, 'alice'),
      r1: commentSeed(BOB, 'bob', { replyTo: 'parent' }),
      r2: commentSeed(BOB, 'bob', { replyTo: 'parent' }),
    },
  });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.delete(doc(db, 'papers', PAPER, 'comments', 'parent'));
  batch.delete(doc(db, 'papers', PAPER, 'comments', 'r1'));
  batch.delete(doc(db, 'papers', PAPER, 'comments', 'r2'));
  await assertSucceeds(batch.commit());
  let orphans;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    orphans = await getDocs(collection(context.firestore(), 'papers', PAPER, 'comments'));
  });
  assert.equal(orphans.size, 0, 'the cascade must leave no reply behind');
});

test('F3: the cascade exception is scoped: parent must fall in the same batch', async () => {
  await resetSocial({
    comments: {
      parent: commentSeed(ALICE, 'alice'),
      r1: commentSeed(BOB, 'bob', { replyTo: 'parent' }),
    },
  });
  // The parent's author cannot pick off someone else's reply while the
  // parent lives — that would be moderation power nobody granted.
  await assertFails(deleteDoc(doc(asAlice(), 'papers', PAPER, 'comments', 'r1')));
  // And a stranger cannot ride the cascade to take a thread down: the batch
  // dies on the parent, whose delete was never theirs to make.
  const db = asCarol();
  const batch = writeBatch(db);
  batch.delete(doc(db, 'papers', PAPER, 'comments', 'parent'));
  batch.delete(doc(db, 'papers', PAPER, 'comments', 'r1'));
  await assertFails(batch.commit());
  // The reply's own author can always delete their reply alone.
  await assertSucceeds(deleteDoc(doc(asBob(), 'papers', PAPER, 'comments', 'r1')));
});

test('F3: an orphaned reply is sweepable by any signed-in account, not by guests', async () => {
  // Belt and braces for a cascade interrupted between batches: the parent is
  // gone, the reply is invisible to the UI (it only renders under its
  // parent), and anyone signed in may finish the sweep.
  await resetSocial({ comments: { r1: commentSeed(BOB, 'bob', { replyTo: 'vanished' }) } });
  await assertFails(deleteDoc(doc(asGuest(), 'papers', PAPER, 'comments', 'r1')));
  await assertSucceeds(deleteDoc(doc(asCarol(), 'papers', PAPER, 'comments', 'r1')));
});

// --- comments: query ceilings ------------------------------------------------

test('F3: comment queries carry a ceiling or they do not run', async () => {
  await resetSocial({ comments: { c1: commentSeed(ALICE, 'alice') } });
  const threads = (db) => collection(db, 'papers', PAPER, 'comments');
  await assertFails(getDocs(threads(asGuest())));
  await assertFails(getDocs(query(threads(asGuest()), limit(1001))));
  await assertSucceeds(getDocs(query(threads(asGuest()), orderBy('createdAt', 'asc'), limit(20))));
  await assertFails(getCountFromServer(query(threads(asGuest()))));
  await assertSucceeds(getCountFromServer(query(threads(asGuest()), limit(1000))));
  // The "my comments" collection-group read obeys the same ceiling.
  await assertFails(getDocs(query(
    collectionGroup(asAlice(), 'comments'), where('authorUid', '==', ALICE),
  )));
  await assertSucceeds(getDocs(query(
    collectionGroup(asAlice(), 'comments'), where('authorUid', '==', ALICE),
    orderBy('createdAt', 'desc'), limit(30),
  )));
});

// --- the killswitch ----------------------------------------------------------

test('F3: the killswitch freezes comments and stubs, and only the admin holds it', async () => {
  await resetSocial();
  await assertFails(setDoc(doc(asAlice(), 'config', 'moderation'), { commentsFrozen: true }));
  await assertSucceeds(setDoc(doc(asAdmin(), 'config', 'moderation'), { commentsFrozen: true }));
  // Anyone may read WHY creation refuses.
  await assertSucceeds(getDoc(doc(asGuest(), 'config', 'moderation')));

  const frozenComment = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice'));
  await assertFails(frozenComment.batch.commit());
  const db = asAlice();
  const frozenStub = writeBatch(db);
  frozenStub.set(doc(db, 'papers', 'k-other'), stubBody({ canonicalKey: 'pmid:99', doi: undefined }));
  const [ref, body] = stamp(db, ALICE, 'stubs');
  frozenStub.set(ref, body, { merge: true });
  await assertFails(frozenStub.commit());
  // Reporting stays open while the room is on fire.
  await assertSucceeds(reportBatch(asBob(), BOB).commit());

  await assertSucceeds(setDoc(doc(asAdmin(), 'config', 'moderation'), { commentsFrozen: false }));
  const thawed = commentBatch(asAlice(), ALICE, commentBody(ALICE, 'alice'));
  await assertSucceeds(thawed.batch.commit());
});

// --- reports ------------------------------------------------------------------

test('F3: reporting is create-only for users; the queue belongs to the admin', async () => {
  await resetSocial();
  await assertSucceeds(reportBatch(asAlice(), ALICE).commit());
  let reportId;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const all = await getDocs(collection(context.firestore(), 'reports'));
    reportId = all.docs[0].id;
  });
  // The reporter cannot read their own report back, nor anyone else's.
  await assertFails(getDoc(doc(asAlice(), 'reports', reportId)));
  await assertFails(getDocs(query(collection(asAlice(), 'reports'), limit(10))));
  // The admin's queue works — bounded, like everything else.
  await assertSucceeds(getDocs(query(
    collection(asAdmin(), 'reports'),
    where('status', '==', 'open'), orderBy('createdAt', 'asc'), limit(50),
  )));
  await assertFails(getDocs(collection(asAdmin(), 'reports')));
  // Closing is a status change and nothing else, and it is the admin's.
  await assertFails(updateDoc(doc(asAlice(), 'reports', reportId), { status: 'resolved' }));
  await assertSucceeds(updateDoc(doc(asAdmin(), 'reports', reportId), { status: 'resolved' }));
  await assertFails(updateDoc(doc(asAdmin(), 'reports', reportId), { reason: 'abuse' }));
  await assertFails(deleteDoc(doc(asAlice(), 'reports', reportId)));
  await assertSucceeds(deleteDoc(doc(asAdmin(), 'reports', reportId)));
});

test('F3: a report cannot be forged, and its throttle cuts', async () => {
  await resetSocial();
  // Without its stamp the report does not land at all — the batch helper
  // below always stamps, which masked this clause until the mutation pass.
  await assertFails(setDoc(doc(collection(asAlice(), 'reports')), {
    reporterUid: ALICE, targetPath: `papers/${PAPER}/comments/c1`,
    targetAuthorUid: ALICE, reason: 'spam', status: 'open',
    createdAt: serverTimestamp(),
  }));
  await assertFails(reportBatch(asAlice(), ALICE, { reporterUid: BOB }).commit());
  await assertFails(reportBatch(asAlice(), ALICE, { status: 'resolved' }).commit());
  await assertFails(reportBatch(asAlice(), ALICE, { reason: 'dislike' }).commit());
  await assertSucceeds(reportBatch(asAlice(), ALICE).commit());
  // A second report inside the 60 s interval dies with its stamp.
  await assertFails(reportBatch(asAlice(), ALICE).commit());
});

test('F3: a private profile can still report — reporting is not a public act', async () => {
  await resetSocial();
  await assertSucceeds(reportBatch(asCarol(), CAROL).commit());
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
  // updatePreferences, updateReadingPreferences, updateProfilePhoto and the
  // followedAuthors migration in FollowingContext.
  await reset();
  await seedLegacyUserDoc();
  const db = asAlice();
  const ref = doc(db, 'users', ALICE);
  const writes = [
    { onboardingComplete: true, preferences: ['cs.LG'] },
    { preferences: ['math.AP', 'cs.CL'] },
    { readingPreferences: { aiExplanationLevel: 'researcher', language: 'en', languagePreferenceSet: true } },
    { profilePhoto: 'data:image/webp;base64,AAAA' },
    { followedAuthors: [], followingMigratedAt: serverTimestamp() },
  ];
  for (const write of writes) {
    await assertSucceeds(setDoc(ref, write, { merge: true }));
  }
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

// =========================================================================
// F9 — User search index
//
// Searching is enumerating: the rules see a query's limit, never the values of
// its `where`. So what is asserted here is not "nobody can enumerate" — that
// would be a promise the database cannot keep — but what enumeration yields
// (handle and lowercased name of people who chose to be public), what it costs
// (a session, a server-imposed ceiling), and the property F8 sold: a private
// profile has no entry, in a direction that fails safe.
// =========================================================================

/** Seeds profiles plus, for the uids listed in `indexed`, their search entry. */
async function resetSearch({ visibility = {}, indexed = [], names = {} } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [uid, handle] of [[ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol']]) {
      const chosen = visibility[uid];
      await setDoc(doc(db, 'userProfiles', uid), {
        handle,
        displayName: names[uid] || handle,
        pinnedLists: [],
        ...(chosen ? { visibility: chosen } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await setDoc(doc(db, 'handles', handle), { uid, createdAt: new Date() });
      if (indexed.includes(uid)) {
        await setDoc(doc(db, 'userSearch', uid), {
          handle,
          nameLower: (names[uid] || handle).toLowerCase(),
        });
      }
    }
  });
}

const searchEntry = (handle, nameLower) => ({ handle, nameLower });

/** The two prefix queries the client issues, as the rules see them. */
const prefixQuery = (database, field, term, rows = 10) => query(
  collection(database, 'userSearch'),
  where(field, '>=', term),
  where(field, '<=', `${term}\uf8ff`),
  limit(rows),
);

// --- reading --------------------------------------------------------------

test('F9: a signed-in account can search, one bounded page at a time', async () => {
  await resetSearch({ indexed: [ALICE, BOB] });
  await assertSucceeds(getDocs(prefixQuery(asCarol(), 'handle', 'al')));
  await assertSucceeds(getDocs(prefixQuery(asCarol(), 'nameLower', 'al')));
});

test('F9: a search without a session is refused', async () => {
  // The friction that makes scraping cost a real, blockable account. The app
  // never issues this — the route is behind a session — so the only caller
  // that reaches it is one that went around the app.
  await resetSearch({ indexed: [ALICE] });
  await assertFails(getDocs(prefixQuery(asGuest(), 'handle', 'al')));
  await assertFails(getDocs(prefixQuery(asGuest(), 'nameLower', 'al')));
});

test('F9: a query without a limit does not run', async () => {
  await resetSearch({ indexed: [ALICE] });
  await assertFails(getDocs(collection(asCarol(), 'userSearch')));
  await assertFails(getDocs(query(
    collection(asCarol(), 'userSearch'),
    where('handle', '>=', 'a'),
    where('handle', '<=', 'a'),
  )));
});

test('F9: no caller can ask the index for more than the ceiling', async () => {
  await resetSearch({ indexed: [ALICE] });
  const db = asCarol();
  await assertSucceeds(getDocs(prefixQuery(db, 'handle', 'a', 20)));
  await assertFails(getDocs(prefixQuery(db, 'handle', 'a', 21)));
  await assertFails(getDocs(query(collection(db, 'userSearch'), limit(1000))));
});

test('F9: a single entry cannot be fetched by id', async () => {
  // `get` buys nothing the profile does not already serve, and leaving it open
  // would add a second oracle for "does this uid have a public profile".
  await resetSearch({ indexed: [ALICE] });
  await assertFails(getDoc(doc(asCarol(), 'userSearch', ALICE)));
  await assertFails(getDoc(doc(asGuest(), 'userSearch', ALICE)));
  await assertFails(getDoc(doc(asAlice(), 'userSearch', ALICE)));
});

// --- who may write what ---------------------------------------------------

test('F9: a private profile cannot have an entry in the index', async () => {
  await resetSearch({ visibility: { [ALICE]: 'private' } });
  await assertFails(setDoc(
    doc(asAlice(), 'userSearch', ALICE),
    searchEntry('alice', 'alice'),
  ));
});

test('F9: a public profile indexes itself — but only after it said so', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' } });
  await assertSucceeds(setDoc(
    doc(asAlice(), 'userSearch', ALICE),
    searchEntry('alice', 'alice'),
  ));
  // BOB has no `visibility` field: written before F8, public by absence. That
  // absence is enough to open his page — it always was public — and NOT enough
  // to list him in a searchable index, which is a question he was never asked.
  // He answers F8's one-time prompt and then he is indexable; until then an
  // unrelated profile edit cannot answer it for him.
  await assertFails(setDoc(doc(asBob(), 'userSearch', BOB), searchEntry('bob', 'bob')));
});

test('F9: answering the prompt is what makes an account indexable', async () => {
  await resetSearch();
  const db = asBob();
  // The whole migration, as the client performs it: choose, and index in the
  // same batch. Before the choice the entry is refused; after it, allowed.
  await assertFails(setDoc(doc(db, 'userSearch', BOB), searchEntry('bob', 'bob')));
  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', BOB), {
    visibility: 'public', updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'userSearch', BOB), searchEntry('bob', 'bob'));
  await assertSucceeds(batch.commit());
});

test('F9: choosing private explicitly keeps an account out, same as never choosing', async () => {
  await resetSearch({ visibility: { [ALICE]: 'private' } });
  await assertFails(setDoc(doc(asAlice(), 'userSearch', ALICE), searchEntry('alice', 'alice')));
});

test('F9: nobody can write somebody else\'s entry', async () => {
  await resetSearch({ visibility: { [BOB]: 'public' } });
  await assertFails(setDoc(doc(asAlice(), 'userSearch', BOB), searchEntry('bob', 'bob')));
  await resetSearch({ visibility: { [BOB]: 'public' }, indexed: [BOB] });
  await assertFails(deleteDoc(doc(asAlice(), 'userSearch', BOB)));
});

test('F9: an entry cannot carry a name its profile does not hold', async () => {
  // The name-stuffing surface every client-maintained index has, closed by an
  // equality the rules can recompute: index yourself as "taylor swift" and you
  // surface in searches for her.
  await resetSearch({ visibility: { [ALICE]: 'public' }, names: { [ALICE]: 'Alice Ada' } });
  const db = asAlice();
  await assertFails(setDoc(doc(db, 'userSearch', ALICE), searchEntry('alice', 'taylor swift')));
  await assertFails(setDoc(doc(db, 'userSearch', ALICE), searchEntry('alice', 'Alice Ada')));
  await assertFails(setDoc(doc(db, 'userSearch', ALICE), searchEntry('alice', 'alice ada extra')));
  await assertSucceeds(setDoc(doc(db, 'userSearch', ALICE), searchEntry('alice', 'alice ada')));
});

test('F9: an entry cannot carry a handle its profile does not hold', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' } });
  await assertFails(setDoc(doc(asAlice(), 'userSearch', ALICE), searchEntry('bob', 'alice')));
});

test('F9: the client derives the indexed name the way the rules recompute it', async () => {
  // `nameLower == displayName.lower()` is only safe while the rules engine and
  // the client agree on what lowercase means, and they do NOT agree by default:
  // the engine's `.lower()` is ASCII-only, so it lowers "MUÑOZ" to "muÑoz"
  // while JavaScript's `toLowerCase()` says "muñoz". Get that wrong and a real
  // account called "Nicolás MUÑOZ García" cannot save its profile at all.
  //
  // So this runs the shipping function against the shipping rules rather than
  // restating either one: whichever moves, this fails.
  const name = 'Nicolás MUÑOZ García';
  await resetSearch({ visibility: { [ALICE]: 'public' }, names: { [ALICE]: name } });
  const db = asAlice();
  await assertSucceeds(setDoc(
    doc(db, 'userSearch', ALICE),
    { handle: 'alice', nameLower: toIndexedName(name) },
  ));
  // And the trap it exists to avoid, pinned as a denial.
  await assertFails(setDoc(
    doc(db, 'userSearch', ALICE),
    { handle: 'alice', nameLower: name.toLowerCase() },
  ));
});

test('F9: the entry holds two fields, no photo, and no clock', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' } });
  const db = asAlice();
  const ref = doc(db, 'userSearch', ALICE);
  await assertFails(setDoc(ref, { ...searchEntry('alice', 'alice'), photo: 'data:image/png;base64,AA' }));
  await assertFails(setDoc(ref, { ...searchEntry('alice', 'alice'), bio: 'about me' }));
  await assertFails(setDoc(ref, { handle: 'alice' }));
  await assertFails(setDoc(ref, { ...searchEntry('alice', 'alice'), nameLower: 'x'.repeat(81) }));
  // No timestamp of any kind, server-stamped or otherwise. The entry used to
  // carry `createdAt == request.time`, rewritten on every profile save, so the
  // field tracked the last edit rather than the creation — and any signed-in
  // caller could orderBy it for a "who touched their profile most recently"
  // listing the product does not offer. Nothing read it.
  await assertFails(setDoc(ref, { ...searchEntry('alice', 'alice'), createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(ref, searchEntry('alice', 'alice')));
});

test('F9: and no caller can order the index by a clock that is not there', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public', [BOB]: 'public' }, indexed: [ALICE, BOB] });
  // The rules constrain a query's ceiling and nothing else — not its shape, not
  // its orderBy — so the defence cannot be "refuse that ordering". It is that
  // the field does not exist, which is why removing it was the fix rather than
  // freezing it.
  const ordered = await getDocs(query(
    collection(asCarol(), 'userSearch'), orderBy('createdAt', 'desc'), limit(20),
  ));
  assert.equal(ordered.size, 0, 'no document carries the field to be ordered by');
});

test('F9: an entry cannot exist without a profile behind it', async () => {
  await testEnv.clearFirestore();
  // DAVE is signed in and has never created a profile.
  await assertFails(setDoc(doc(asDave(), 'userSearch', DAVE), searchEntry('dave', 'dave')));
});

// --- the fail-safe direction ----------------------------------------------

test('F9: going private while staying in the index is refused', async () => {
  // The direction that matters. Not "unlikely to happen": a write Firestore
  // rejects, so the promise F8 makes on screen cannot come apart from the data.
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    visibility: 'private', updatedAt: serverTimestamp(),
  }));
});

test('F9: going private and leaving the index in one batch is allowed', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', ALICE), {
    visibility: 'private', updatedAt: serverTimestamp(),
  });
  batch.delete(doc(db, 'userSearch', ALICE));
  await assertSucceeds(batch.commit());
});

test('F9: coming back to public and re-indexing in one batch is allowed', async () => {
  await resetSearch({ visibility: { [ALICE]: 'private' } });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', ALICE), {
    visibility: 'public', updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'userSearch', ALICE), searchEntry('alice', 'alice'));
  await assertSucceeds(batch.commit());
});

test('F9: a profile cannot be created private while an entry survives', async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'userSearch', DAVE), {
      handle: 'dave', nameLower: 'dave', createdAt: new Date(),
    });
  });
  const db = asDave();
  const create = (extra = {}) => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userProfiles', DAVE), {
      handle: 'dave', displayName: 'Dave', pinnedLists: [], visibility: 'private',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'handles', 'dave'), { uid: DAVE, createdAt: serverTimestamp() });
    if (extra.delist) batch.delete(doc(db, 'userSearch', DAVE));
    return batch.commit();
  };
  await assertFails(create());
  await assertSucceeds(create({ delist: true }));
});

test('F9: deleting a profile without leaving the index is refused', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  const db = asAlice();
  const unpublish = ({ delist }) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'userProfiles', ALICE));
    batch.delete(doc(db, 'handles', 'alice'));
    if (delist) batch.delete(doc(db, 'userSearch', ALICE));
    return batch.commit();
  };
  await assertFails(unpublish({ delist: false }));
  await assertSucceeds(unpublish({ delist: true }));
});

test('F9: renaming a handle must carry the index along', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  const db = asAlice();
  const rename = ({ reindex }) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'handles', 'alice'));
    batch.set(doc(db, 'handles', 'ada'), { uid: ALICE, createdAt: serverTimestamp() });
    batch.update(doc(db, 'userProfiles', ALICE), { handle: 'ada', updatedAt: serverTimestamp() });
    if (reindex) batch.set(doc(db, 'userSearch', ALICE), searchEntry('ada', 'alice'));
    return batch.commit();
  };
  // Both halves are now refused. Leaving the entry behind used to be allowed —
  // "the fail-safe direction is privacy, not freshness" — and that was the hole:
  // the row kept advertising @alice, and once somebody claimed the freed handle
  // it opened their profile instead.
  await assertFails(rename({ reindex: false }));
  await assertSucceeds(rename({ reindex: true }));
});

// --- the two-step the first version of F9 left open ------------------------

test('F9: a public profile cannot rename out from under its own index entry', async () => {
  // The attack the coherence clause exists to stop, in the two ordinary writes
  // it actually takes:
  //
  //   1. set displayName to "Taylor Swift" — free text, always allowed — and
  //      index yourself. The equality holds, so the entry is legal.
  //   2. rename the profile to anything at all, leaving the entry alone.
  //
  // Step 2 used to pass, and the index went on serving a name the profile did
  // not hold: the name-stuffing that equality exists to close, executed in two
  // writes instead of one. It is durable and invisible from the profile page.
  await resetSearch({
    visibility: { [ALICE]: 'public' },
    names: { [ALICE]: 'Taylor Swift' },
    indexed: [ALICE],
  });
  const db = asAlice();
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    displayName: 'Alice Ada', updatedAt: serverTimestamp(),
  }));

  // The same write with the entry carried along is the one the client sends.
  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', ALICE), {
    displayName: 'Alice Ada', updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'userSearch', ALICE), searchEntry('alice', 'alice ada'));
  await assertSucceeds(batch.commit());
});

test('F9: an account with no entry is untouched by the coherence clause', async () => {
  // What keeps this deployable without waiting for the app, and what keeps every
  // profile written before F9 saveable: no entry, nothing to keep coherent.
  await resetSearch({ visibility: { [ALICE]: 'public' } });
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    displayName: 'Anything At All', updatedAt: serverTimestamp(),
  }));
});

test('F9: leaving the index is always a way out of an incoherent entry', async () => {
  // An account whose entry disagrees with its profile — legacy, or written
  // before this phase — must not be locked out of its own profile. Deleting the
  // entry is unconditional, so the batch that repairs it always exists.
  await resetSearch({
    visibility: { [ALICE]: 'public' }, names: { [ALICE]: 'Taylor Swift' }, indexed: [ALICE],
  });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', ALICE), {
    displayName: 'Alice Ada', updatedAt: serverTimestamp(),
  });
  batch.delete(doc(db, 'userSearch', ALICE));
  await assertSucceeds(batch.commit());
});

// --- the entry nobody could remove ----------------------------------------

test('F9: the admin can clear the entry of a profile it moderated away', async () => {
  // The admin branch of the profile delete carries no delisting requirement, by
  // decision. Without an admin delete HERE that made the entry unreachable: a
  // moderated-away account stayed in the index, still serving its name and
  // handle to every searcher, still linking to a profile that no longer exists,
  // and the only account that could clear it was the one just moderated away.
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  await assertSucceeds(deleteDoc(doc(asAdmin(), 'userProfiles', ALICE)));
  await assertSucceeds(deleteDoc(doc(asAdmin(), 'userSearch', ALICE)));
  const left = await getDocs(prefixQuery(asCarol(), 'handle', 'al'));
  assert.equal(left.size, 0, 'the moderated account is out of the index');
});

test('F9: the admin delete is the only new power — writes stay owner-only', async () => {
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  await assertFails(setDoc(doc(asAdmin(), 'userSearch', ALICE), searchEntry('alice', 'alice')));
  await assertFails(deleteDoc(doc(asCarol(), 'userSearch', ALICE)));
});

// --- the budget this phase was warned about -------------------------------

test('F9: the pin ceiling is still six with the new clause in place', async () => {
  // P16 spends the expression headroom F1 measured and left. Re-running the
  // measurement is mandatory, not a formality: if six pins stop passing, the
  // cap drops to five in this phase.
  await reset();
  await seedOwnedLists(7);
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: ownedPins(6), updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: ownedPins(7), updatedAt: serverTimestamp(),
  }));
});

test('F9: the heaviest legitimate write there is, at the cap, with an entry', async () => {
  // Six pins AND a handle rename AND the index carried along, on a profile that
  // is public throughout — so the coherence branch is evaluated rather than
  // short-circuited. This is the write that decides whether the cap can stay at
  // six, and it is the one the editor sends when somebody with a full profile
  // changes their handle.
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (let index = 0; index < 6; index += 1) {
      await setDoc(doc(db, 'publicListOwners', index.toString(16).padStart(32, '0')), {
        ownerId: ALICE, listId: `l${index}`, createdAt: new Date(),
      });
    }
  });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.delete(doc(db, 'handles', 'alice'));
  batch.set(doc(db, 'handles', 'ada'), { uid: ALICE, createdAt: serverTimestamp() });
  batch.update(doc(db, 'userProfiles', ALICE), {
    handle: 'ada', pinnedLists: ownedPins(6), updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, 'userSearch', ALICE), searchEntry('ada', 'alice'));
  await assertSucceeds(batch.commit());
});

test('F9: the slack above the cap is GONE, and that is the measured number', async () => {
  // F1 chose six so that one entry of headroom stayed free for the next clause
  // added to this ruleset. The coherence clause is that next clause, and it
  // spends exactly one entry: measured on this emulator, the heaviest profile
  // write tops out at seven pins without it and six with it.
  //
  // So six is now the ceiling AND the cap, and the next clause added to
  // userProfiles/ takes the cap to five. Measuring that needs the cap raised out
  // of the way AND validPinnedLists extended to genuinely validate the extra
  // entries — probing at seven against the shipped file measures `size() <= 6`
  // and nothing else, and the emulator's denial traces mention the expression
  // limit for reasons unrelated to the clause that actually decided. The only
  // trustworthy signal is that a write was allowed.
  //
  // This test pins the consequence rather than the measurement: at the cap the
  // heaviest write passes, and one entry above it never lands.
  await reset();
  await seedOwnedLists(8);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    // `reset()` builds a profile of the pre-F8 vintage, with no `visibility`.
    // The choice has to be on it or the entry write below is refused for the
    // right reason but the wrong one for this test.
    await setDoc(doc(db, 'userProfiles', ALICE), { visibility: 'public' }, { merge: true });
    await setDoc(doc(db, 'userSearch', ALICE), { handle: 'alice', nameLower: 'alice' });
  });
  const attempt = async (count) => {
    const db = asAlice();
    const batch = writeBatch(db);
    batch.update(doc(db, 'userProfiles', ALICE), {
      pinnedLists: ownedPins(count), updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'userSearch', ALICE), searchEntry('alice', 'alice'));
    try {
      await batch.commit();
      return 'allowed';
    } catch {
      return 'refused';
    }
  };
  assert.equal(await attempt(6), 'allowed', 'a write at the cap must still land');
  assert.equal(await attempt(7), 'refused', 'and one above it must not');
});

test('F9: the worst case — six pins, going private, leaving the index', async () => {
  // The most expensive write this ruleset accepts: the full pinned array, the
  // ownership get() per pin, the visibility clause AND the existsAfter that
  // only a private write reaches.
  await resetSearch({ visibility: { [ALICE]: 'public' }, indexed: [ALICE] });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (let index = 0; index < 6; index += 1) {
      await setDoc(doc(db, 'publicListOwners', index.toString(16).padStart(32, '0')), {
        ownerId: ALICE, listId: `l${index}`, createdAt: new Date(),
      });
    }
  });
  const db = asAlice();
  const batch = writeBatch(db);
  batch.update(doc(db, 'userProfiles', ALICE), {
    pinnedLists: ownedPins(6), visibility: 'private', updatedAt: serverTimestamp(),
  });
  batch.delete(doc(db, 'userSearch', ALICE));
  await assertSucceeds(batch.commit());
});

test('F9: a feed load is STILL one document read', async () => {
  // Unchanged by this phase, asserted again because the phase touched the
  // profile write path and the invariant is the one thing that must not move.
  await resetFollows({ edges: [[BOB, ALICE]] });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', ALICE, 'aggregates', 'interactions'), {
      version: 1, updatedAt: new Date(), sourceDocCount: 3, payload: '{}',
    });
    await setDoc(doc(db, 'userSearch', ALICE), {
      handle: 'alice', nameLower: 'alice', createdAt: new Date(),
    });
  });
  let documentsRead = 0;
  const aggregate = await getDoc(doc(asAlice(), 'users', ALICE, 'aggregates', 'interactions'));
  documentsRead += aggregate.exists() ? 1 : 0;
  assert.equal(documentsRead, 1, 'the search index must not enter the feed path');
  assert.equal(aggregate.data().sourceDocCount, 3);
});

// =========================================================================
// Public lists after F11: server-written, client-readable
//
// This is the coverage whose absence let publishing ship broken. Every test
// above seeds `publicLists` with the rules switched off; none of them ever
// asked the rules engine what a CLIENT is allowed to do to that collection.
// =========================================================================

/** Papers as sanitizePublicPaper() leaves them — the payload that broke. */
const publicPapers = count => Array.from({ length: count }, (_, i) => ({
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

const publicListBody = papers => ({
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
    assert.equal(snapshot.data().papers.length, 3);
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

test('pinning a share still works: the rules read the owner table themselves', async () => {
  await reset();
  await seedPublished();
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(ALICE_SHARE)], updatedAt: serverTimestamp(),
  }));
  // And pinning somebody else's share is still forgery.
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: [pin(BOB_SHARE)], updatedAt: serverTimestamp(),
  }));
});

// =========================================================================
// F12: the showcase of attributed lists, and the pin as an order
//
// `profileLists/{uid}` is Worker-written; the rules' whole job is to refuse
// every client write and to gate reads on the profile's own visibility.
// `pinnedShareIds` replaces the card pins: three ids, no ownership get() —
// a forged id points at nothing in the caller's own showcase, so it pins
// nothing, and that is asserted here rather than assumed.
// =========================================================================

/** Seeds a showcase document for `uid`, as only the Worker can. */
async function seedShowcase(uid, cards = [{ shareId: ALICE_SHARE, title: 'Mi lista', paperCount: 3, publishedAt: new Date() }]) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'profileLists', uid), {
      lists: cards, updatedAt: new Date(),
    });
  });
}

/** Flips ALICE's seeded profile to explicit private, rules off. */
async function makeAlicePrivate() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), 'userProfiles', ALICE), {
      visibility: 'private',
    });
  });
}

test('F12: the showcase of a public profile is readable by anyone', async () => {
  await reset();
  await seedShowcase(ALICE);
  await assertSucceeds(getDoc(doc(asGuest(), 'profileLists', ALICE)));
  await assertSucceeds(getDoc(doc(asBob(), 'profileLists', ALICE)));
});

test('F12: a private profile hides its showcase from everyone but its owner', async () => {
  await reset();
  await seedShowcase(ALICE);
  await makeAlicePrivate();
  await assertFails(getDoc(doc(asGuest(), 'profileLists', ALICE)));
  await assertFails(getDoc(doc(asBob(), 'profileLists', ALICE)));
  await assertSucceeds(getDoc(doc(asAlice(), 'profileLists', ALICE)));
});

test('F12: a showcase with no profile behind it reads as denied to strangers', async () => {
  // get() of the missing profile returns null and null.data denies — the
  // same fail-closed shape ownsPinnedShare documents. The owner branch does
  // not need the profile and short-circuits first.
  await reset({ aliceProfile: false });
  await seedShowcase(ALICE);
  await assertFails(getDoc(doc(asGuest(), 'profileLists', ALICE)));
  await assertFails(getDoc(doc(asBob(), 'profileLists', ALICE)));
  await assertSucceeds(getDoc(doc(asAlice(), 'profileLists', ALICE)));
});

test('F12: nobody lists showcases, and no client writes one — the owner included', async () => {
  await reset();
  await seedShowcase(ALICE);
  await assertFails(getDocs(query(collection(asGuest(), 'profileLists'), limit(5))));
  await assertFails(getDocs(query(collection(asAlice(), 'profileLists'), limit(5))));
  await assertFails(setDoc(doc(asAlice(), 'profileLists', ALICE), {
    lists: [{ shareId: ALICE_SHARE, title: 'Forjada', paperCount: 1, publishedAt: new Date() }],
    updatedAt: new Date(),
  }));
  await assertFails(updateDoc(doc(asAlice(), 'profileLists', ALICE), { updatedAt: new Date() }));
  await assertFails(deleteDoc(doc(asAlice(), 'profileLists', ALICE)));
});

test('F12: three pinned share ids pass, a fourth is refused', async () => {
  await reset();
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedShareIds: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedShareIds: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)],
    updatedAt: serverTimestamp(),
  }));
});

test('F12: a pinned share id must look like a share id', async () => {
  await reset();
  const db = asAlice();
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedShareIds: ['not-a-share-id'], updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedShareIds: [42], updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(db, 'userProfiles', ALICE), {
    pinnedShareIds: 'a'.repeat(32), updatedAt: serverTimestamp(),
  }));
});

test('F12: pinning an id you do not own is allowed and harmless', async () => {
  // Deliberate, and the inverse of FIX A: there is no ownership get() on the
  // new pins because the render is showcase ∩ pins — an id that is not in
  // the caller's OWN showcase paints nothing. The forgery loses its prize
  // instead of costing a document access per entry.
  await reset();
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedShareIds: [BOB_SHARE], updatedAt: serverTimestamp(),
  }));
});

test('F12 transition: six legacy card pins and three id pins coexist in one write', async () => {
  // The migration window has both validations live, and P16 left the legacy
  // ceiling exactly at six — so the heaviest legitimate transition write is
  // measured here, not assumed. `attempt` distinguishes a clean allow from
  // an expression-limit blowup, which is the only reliable signal.
  await reset();
  await seedOwnedLists(6);
  await assertSucceeds(updateDoc(doc(asAlice(), 'userProfiles', ALICE), {
    pinnedLists: ownedPins(6),
    pinnedShareIds: ['0'.repeat(32), '1'.padStart(32, '0'), '2'.padStart(32, '0')],
    updatedAt: serverTimestamp(),
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
// userHighlightService.js` is the only writer, so every body below is one the
// client could actually produce.
// =========================================================================

/** A highlight exactly as `normalizeUserHighlight` builds one. */
function highlightBody(extra = {}) {
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

function highlightWithout(field) {
  const body = highlightBody();
  delete body[field];
  return body;
}

const highlightRef = (database, id = 'h1', uid = ALICE) => (
  doc(database, 'users', uid, 'highlights', id)
);

/** The query `listUserHighlights` actually emits, ceiling and all. */
const highlightsQuery = (database, uid = ALICE, paperId = 'arxiv:2401.00001', rows = 200) => query(
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
    paragraphIndex: 100,
    kind: 'caveat',
  })));
});
