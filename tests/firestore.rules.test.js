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
import { PUBLIC_LIST_LIMITS } from '../src/services/publicListPayload.js';
import { buildSavedPaperPayload } from '../src/utils/savedPaperPayload.js';
import { LIST_COLORS } from '../src/utils/listColors.js';
import { USER_PREFERENCES_MAX } from '../src/utils/accountOnboarding.js';
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

test('a profile cannot be born on top of somebody else\'s reservation', async () => {
  // Alice holds handles/alice. Bob writes a profile that names that handle
  // and does not touch the reservation at all: `existsAfter()` was satisfied
  // by Alice's document, so the profile landed — and the Worker, deleting
  // Bob's account, freed Alice's handle (audit 2026-09-10, finding 1). The
  // reservation after the batch has to be the caller's, not just present.
  await reset();
  const db = asBob();
  await assertFails(setDoc(doc(db, 'userProfiles', BOB), {
    handle: 'alice', displayName: 'Bob', pinnedLists: [], visibility: 'private',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  // Absence still refuses, as it did with existsAfter: getAfter() on a
  // document that does not exist after the batch is an evaluation error.
  await assertFails(setDoc(doc(db, 'userProfiles', BOB), {
    handle: 'nobody', displayName: 'Bob', pinnedLists: [], visibility: 'private',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  let stored;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    stored = (await getDoc(doc(context.firestore(), 'handles', 'alice'))).data();
  });
  assert.equal(stored.uid, ALICE, 'the reservation never changed hands');
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
// F8 — Profile visibility
//
// The whole point of this phase is that "private" is a property of the data,
// not of the screen. Every test here performs a real read as a real caller.
// =========================================================================

/** Seeds two profiles whose visibility is set per uid. `null` = legacy. */
async function resetVisibility({ visibility = {} } = {}) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [uid, handle] of [[ALICE, 'alice'], [BOB, 'bob']]) {
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

test('the photo choice is a state the profile can carry', async () => {
  // The writes the client makes: created with the choice, hidden from
  // Privacy, and shown again by mirroring an upload.
  await reset({ aliceProfile: false });
  const db = asAlice();
  const create = (showPhoto) => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice', pinnedLists: [], visibility: 'public',
      showPhoto, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: serverTimestamp() });
    return batch.commit();
  };
  await assertFails(create('yes'));
  await assertSucceeds(create(true));
  const profile = doc(db, 'userProfiles', ALICE);
  await assertSucceeds(updateDoc(profile, {
    photo: deleteField(), showPhoto: false, updatedAt: serverTimestamp(),
  }));
  await assertSucceeds(updateDoc(profile, {
    photo: 'https://lh3.googleusercontent.com/a/photo', showPhoto: true, updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(profile, { showPhoto: 1, updatedAt: serverTimestamp() }));
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
// Comments, paper stubs, reports and the moderation switch are closed. The app
// no longer has comments; what earlier versions wrote is left to the Worker's
// service account, which account deletion uses to dissociate a user's
// comments and which the rules do not govern.
// =========================================================================

const DAVE = 'dave-uid'; // signed in, never created a profile
// Whatever uid isAdmin() currently carries — the placeholder before the P7
// paste, the real one after. Read from the rules text so pasting the real
// uid does not orphan every admin test; the emulator authenticates as any
// string either way.
const ADMIN = (await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'))
  .match(/request\.auth\.uid == '([^']+)'/)?.[1] ?? 'REPLACE_WITH_ADMIN_UID';
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

test('a preference list is capped at 100, and the cap is where the client says it is', async () => {
  // USER_PREFERENCES_MAX (src/utils/accountOnboarding.js) is what the pickers
  // enforce; this is the rules engine agreeing with them. One over is refused
  // outright, which is why the onboarding must never let a list that long
  // reach the write (audit of 2026-09-16, hallazgo 4).
  await reset();
  await seedLegacyUserDoc();
  const ref = doc(asAlice(), 'users', ALICE);
  const list = (n) => Array.from({ length: n }, (_, i) => `cat.${i}`);
  await assertSucceeds(setDoc(ref, { onboardingComplete: true, preferences: list(USER_PREFERENCES_MAX) }, { merge: true }));
  await assertFails(setDoc(ref, { onboardingComplete: true, preferences: list(USER_PREFERENCES_MAX + 1) }, { merge: true }));
  await assertFails(setDoc(ref, { preferences: list(USER_PREFERENCES_MAX + 1) }, { merge: true }));
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

test('the public profile may carry the institution only as an exact copy of the verified one', async () => {
  await reset();
  await seedLegacyUserDoc({ institution: INSTITUTION });
  const ref = doc(asAlice(), 'userProfiles', ALICE);
  await assertSucceeds(updateDoc(ref, { institution: INSTITUTION, updatedAt: serverTimestamp() }));
  // One field off, or an institution the account never verified: refused.
  await assertFails(updateDoc(ref, { institution: { ...INSTITUTION, acronym: 'MIT' }, updatedAt: serverTimestamp() }));
  // Writes that leave the field alone keep working, as every profile edit does.
  await assertSucceeds(updateDoc(ref, { displayName: 'Alice Renamed', updatedAt: serverTimestamp() }));
});

test('the institution copy leaves the rules budget room for the heaviest profile write', async () => {
  // Six pins plus a handle change is the write that sits closest to the
  // emulator's 1000-expression ceiling (FIX A). Carrying the institution
  // along, as a merged document does, must not push it over.
  await reset();
  await seedOwnedLists(6);
  await seedLegacyUserDoc({ institution: INSTITUTION });
  const db = asAlice();
  await assertSucceeds(updateDoc(doc(db, 'userProfiles', ALICE), {
    institution: INSTITUTION, pinnedLists: ownedPins(6), updatedAt: serverTimestamp(),
  }));
  const batch = writeBatch(db);
  batch.set(doc(db, 'handles', 'alice2'), { uid: ALICE, createdAt: serverTimestamp() });
  batch.delete(doc(db, 'handles', 'alice'));
  batch.update(doc(db, 'userProfiles', ALICE), {
    handle: 'alice2', institution: INSTITUTION, pinnedLists: ownedPins(6), updatedAt: serverTimestamp(),
  });
  await assertSucceeds(batch.commit());
});

test('a profile cannot claim an institution its account does not have', async () => {
  await reset();
  await seedLegacyUserDoc();
  const ref = doc(asAlice(), 'userProfiles', ALICE);
  await assertFails(updateDoc(ref, { institution: INSTITUTION, updatedAt: serverTimestamp() }));
  // Nor can a stranger put one on somebody else's page.
  await assertFails(updateDoc(doc(asBob(), 'userProfiles', ALICE), { institution: INSTITUTION, updatedAt: serverTimestamp() }));
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
  assert.equal(aggregate.data().sourceDocCount, 3, 'and that document is the usable one');

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
    paragraphIndex: 100,
    kind: 'caveat',
  })));
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

  const papers = [
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
    await assertSucceeds(
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
