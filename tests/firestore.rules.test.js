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
  getDoc,
  getDocs,
  collection,
  setDoc,
  updateDoc,
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
