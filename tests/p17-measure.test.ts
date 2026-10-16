/**
 * P17 (granular privacy) — measurement, not reasoning.
 *
 * The design under test, forced into shape by earlier probe rounds:
 *
 * - The likes/saved toggles are NOT profile fields. Each public shelf is its
 *   own document, `profileShowcase/{uid}/shelves/{likes|saved}`, and the
 *   toggle IS the document's existence. An ordinary public profile save
 *   evaluates zero new expressions; only the private/delete branch pays two
 *   `existsAfter` calls. (A first candidate with `showLikes`/`showSaved`
 *   profile fields plus a coherence clause was measured and dropped: it took
 *   the pin cap from six to five.)
 * - One shelf per document because the card validation is what eats the
 *   budget: measured bare, a single evaluation fits 8 cards but not 12, and
 *   two 6-card shelves in one document already blow it.
 * - `showFollowers` lives on the profile (follows/ rules must `get()` it),
 *   absence meaning public. The one-rule split of follows/ list by direction
 *   was measured to work: equality on `followerUid` lets the engine prove
 *   `resource.data.followerUid is string`, so the following direction stays
 *   open while the followers direction gates on the target's flag.
 *
 * Method calqued from f9-measure.test.js: the candidate is built by string
 * surgery on the SHIPPED rules (each anchor asserted verbatim first), the pin
 * unroll is genuinely extended to N entries, and the only trusted signal is
 * allowed/denied — denial traces mention "1000 expressions" for unrelated
 * reasons, so classifying by message lies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection, doc, getDoc, getDocs, getCountFromServer, limit, query,
  setDoc, updateDoc, where, writeBatch, serverTimestamp,
} from 'firebase/firestore';

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const CARA = 'cara-uid';
const SHIPPING = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Candidate construction: string surgery with asserted anchors.
// ---------------------------------------------------------------------------

function splice(rules, anchor, replacement, label) {
  assert.ok(rules.includes(anchor), `anchor not found verbatim: ${label}`);
  assert.equal(rules.split(anchor).length, 2, `anchor not unique: ${label}`);
  return rules.replace(anchor, replacement);
}

let CANDIDATE = SHIPPING;

// 1. validPublicProfile: one new optional bool field, showFollowers.
CANDIDATE = splice(
  CANDIDATE,
  `'allowContact', 'visibility', 'showPinnedLists', 'pinnedLists',`,
  `'allowContact', 'visibility', 'showPinnedLists', 'pinnedLists',
          'showFollowers',`,
  'hasOnly allowlist',
);
CANDIDATE = splice(
  CANDIDATE,
  `        && (!('showPinnedLists' in request.resource.data)
          || request.resource.data.showPinnedLists is bool)`,
  `        && (!('showPinnedLists' in request.resource.data)
          || request.resource.data.showPinnedLists is bool)
        && (!('showFollowers' in request.resource.data)
          || request.resource.data.showFollowers is bool)`,
  'showPinnedLists type check',
);

// 2. Shelf-absence helper; the private branch of profileSearchStateValid
//    pays for it, the public branch never evaluates it.
CANDIDATE = splice(
  CANDIDATE,
  `    function profileSearchStateValid(uid) {
      return profileIsPublic(request.resource.data)
        ? searchIndexCoherentAfter(uid)
        : searchIndexAbsentAfter(uid);
    }`,
  `    function shelvesAbsentAfter(uid) {
      return !existsAfter(/databases/$(database)/documents/profileShowcase/$(uid)/shelves/likes)
        && !existsAfter(/databases/$(database)/documents/profileShowcase/$(uid)/shelves/saved);
    }

    function profileSearchStateValid(uid) {
      return profileIsPublic(request.resource.data)
        ? searchIndexCoherentAfter(uid)
        : (searchIndexAbsentAfter(uid) && shelvesAbsentAfter(uid));
    }`,
  'profileSearchStateValid',
);

// 3. Deleting the profile takes its shelves with it.
CANDIDATE = splice(
  CANDIDATE,
  `          && searchIndexAbsentAfter(profileUid))`,
  `          && searchIndexAbsentAfter(profileUid)
          && shelvesAbsentAfter(profileUid))`,
  'delete fail-safe',
);

// 4. The shelves, inserted ahead of the follows section.
const SHOWCASE_BLOCK = `    function validShowcaseCard(entry) {
      return entry is map
        && entry.keys().hasOnly(['id', 'title', 'authorsLine', 'year'])
        && validString(entry.id, 300) && entry.id.size() > 0
        && validString(entry.title, 500) && entry.title.size() > 0
        && (!('authorsLine' in entry) || validString(entry.authorsLine, 200))
        && (!('year' in entry)
          || entry.year is int && entry.year >= 1000 && entry.year <= 3000);
    }

    function validShowcaseShelf(entries) {
      return entries is list
        && entries.size() <= 6
        && (entries.size() < 1 || validShowcaseCard(entries[0]))
        && (entries.size() < 2 || validShowcaseCard(entries[1]))
        && (entries.size() < 3 || validShowcaseCard(entries[2]))
        && (entries.size() < 4 || validShowcaseCard(entries[3]))
        && (entries.size() < 5 || validShowcaseCard(entries[4]))
        && (entries.size() < 6 || validShowcaseCard(entries[5]));
    }

    match /profileShowcase/{showcaseUid}/shelves/{shelfId} {
      allow get: if true;
      allow list: if false;
      allow create, update: if request.auth != null
        && request.auth.uid == showcaseUid
        && (shelfId == 'likes' || shelfId == 'saved')
        && request.resource.data.keys().hasOnly(['entries', 'updatedAt'])
        && request.resource.data.updatedAt == request.time
        // Explicitly public, the hardened F9 form: publishing a shelf is a
        // new public act, open only to accounts that answered the P15 choice.
        && 'visibility' in searchProfileAfter(showcaseUid)
        && searchProfileAfter(showcaseUid).visibility == 'public'
        && validShowcaseShelf(request.resource.data.entries);
      allow delete: if request.auth != null && request.auth.uid == showcaseUid;
    }

`;
CANDIDATE = splice(
  CANDIDATE,
  `    // ---------------------------------------------------------------------
    // User follows (F2). Additive: nothing above this line changes.`,
  `${SHOWCASE_BLOCK}    // ---------------------------------------------------------------------
    // User follows (F2). Additive: nothing above this line changes.`,
  'follows section header',
);

// 5. follows/: gate the followers direction on the target's flag.
CANDIDATE = splice(
  CANDIDATE,
  `    function validFollowUid(uid) {`,
  `    function followersShownFor(uid) {
      return get(/databases/$(database)/documents/userProfiles/$(uid))
        .data.get('showFollowers', true) == true;
    }

    function validFollowUid(uid) {`,
  'validFollowUid',
);
CANDIDATE = splice(
  CANDIDATE,
  `      allow get: if true;
      allow list: if request.query.limit <= 1000;
      // The \`!= null\` is the same belt-and-braces`,
  `      allow get: if (request.auth != null
          && (resource.data.followerUid == request.auth.uid
            || resource.data.targetUid == request.auth.uid))
        || followersShownFor(resource.data.targetUid);
      allow list: if request.query.limit <= 1000
        && (
          resource.data.followerUid is string
          || (request.auth != null && resource.data.targetUid == request.auth.uid)
          || followersShownFor(resource.data.targetUid)
        );
      // The \`!= null\` is the same belt-and-braces`,
  'follows read rules',
);

// ---------------------------------------------------------------------------
// Harness (calqued from f9-measure.test.js).
// ---------------------------------------------------------------------------

/** Rewrites validPinnedLists so it really validates `size` entries. */
function withPinCap(rules, size) {
  const body = [
    '    function validPinnedLists(entries) {',
    '      return entries is list',
    `        && entries.size() <= ${size}`,
    ...Array.from({ length: size }, (_, i) => (
      `        && (entries.size() < ${i + 1} || validPinnedList(entries[${i}]))`
    )),
    '    }',
  ].join('\n').replace(/\)\)\n {4}}$/, '));\n    }');
  const pattern = / {4}function validPinnedLists\(entries\) \{[\s\S]*?\n {4}\}/;
  assert.match(rules, pattern, 'validPinnedLists must have been found');
  return rules.replace(pattern, body);
}

/** Rewrites validShowcaseShelf so it really validates `size` cards. */
function withShelfCap(rules, size) {
  const body = [
    '    function validShowcaseShelf(entries) {',
    '      return entries is list',
    `        && entries.size() <= ${size}`,
    ...Array.from({ length: size }, (_, i) => (
      `        && (entries.size() < ${i + 1} || validShowcaseCard(entries[${i}]))`
    )),
    '    }',
  ].join('\n').replace(/\)\)\n {4}}$/, '));\n    }');
  const pattern = / {4}function validShowcaseShelf\(entries\) \{[\s\S]*?\n {4}\}/;
  assert.match(rules, pattern, 'validShowcaseShelf must have been found');
  return rules.replace(pattern, body);
}

const HOST = process.env.FIRESTORE_EMULATOR_HOST.split(':')[0];
const PORT = Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
const created = [];
async function envFor(rules, key, attempt = 0) {
  try {
    const env = await initializeTestEnvironment({
      projectId: `papertok-p17-${key}`,
      firestore: { rules, host: HOST, port: PORT },
    });
    created.push(env);
    return env;
  } catch (error) {
    // The emulator intermittently answers 500 to loadRules under repeated
    // project creation; a retry with a fresh project id gets through.
    if (attempt < 3) return envFor(rules, `${key}r${attempt}`, attempt + 1);
    console.log(`  [${key}] rules failed to load: ${String(error.message).slice(0, 300)}`);
    throw error;
  }
}
test.after(async () => {
  for (const env of created) await env.cleanup();
});

const shareId = n => n.toString(16).padStart(32, '0');
const pins = count => Array.from({ length: count }, (_, i) => ({
  shareId: shareId(i), title: `List ${i}`, paperCount: 3,
}));
const cards = count => Array.from({ length: count }, (_, i) => ({
  id: `arxiv:2608.${String(18000 + i)}`, title: `Paper ${i}`,
  authorsLine: 'A. Ada, B. Byron', year: 2026,
}));

async function allowed(run) {
  try { await run(); return true; } catch { return false; }
}

const likesShelf = db => doc(db, 'profileShowcase', ALICE, 'shelves', 'likes');
const savedShelf = db => doc(db, 'profileShowcase', ALICE, 'shelves', 'saved');

/**
 * Seeds Alice with `count` pins and the given profile extras; optionally a
 * search entry, live shelves, and a follows edge BOB -> ALICE.
 */
async function seed(env, count, {
  extras = {}, indexed = true, shelves = false, edge = false,
} = {}) {
  await env.clearFirestore();
  let createdAt = null;
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (let i = 0; i < Math.max(count, 1); i += 1) {
      await setDoc(doc(db, 'publicListOwners', shareId(i)), {
        ownerId: ALICE, listId: `l${i}`, createdAt: new Date(),
      });
    }
    await setDoc(doc(db, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice Ada', pinnedLists: pins(count),
      visibility: 'public', createdAt: new Date(), updatedAt: new Date(),
      ...extras,
    });
    await setDoc(doc(db, 'handles', 'alice'), { uid: ALICE, createdAt: new Date() });
    if (indexed) {
      await setDoc(doc(db, 'userSearch', ALICE), {
        handle: 'alice', nameLower: 'alice ada',
      });
    }
    if (shelves) {
      await setDoc(likesShelf(db), { entries: cards(6), updatedAt: new Date() });
      await setDoc(savedShelf(db), { entries: cards(6), updatedAt: new Date() });
    }
    if (edge) {
      await setDoc(doc(db, 'follows', `${BOB}_${ALICE}`), {
        followerUid: BOB, targetUid: ALICE, createdAt: new Date(),
      });
      await setDoc(doc(db, 'userProfiles', BOB), {
        handle: 'bob', displayName: 'Bob Byron', pinnedLists: [],
        visibility: 'public', createdAt: new Date(), updatedAt: new Date(),
      });
    }
    createdAt = (await getDoc(doc(db, 'userProfiles', ALICE))).data().createdAt;
  });
  return createdAt;
}

const profileBody = (count, createdAt, extras = {}) => ({
  handle: 'alice', displayName: 'Alice Ada', pinnedLists: pins(count),
  visibility: 'public', createdAt, updatedAt: serverTimestamp(), ...extras,
});

const ordinarySave = (db, count, createdAt, extras = {}) => {
  const batch = writeBatch(db);
  batch.set(doc(db, 'userProfiles', ALICE), profileBody(count, createdAt, extras));
  batch.set(doc(db, 'userSearch', ALICE), {
    handle: 'alice', nameLower: 'alice ada',
  });
  return batch.commit();
};

const renameAtCap = (db, count, createdAt, extras = {}) => {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'handles', 'alice'));
  batch.set(doc(db, 'handles', 'ada'), { uid: ALICE, createdAt: serverTimestamp() });
  batch.set(doc(db, 'userProfiles', ALICE), {
    ...profileBody(count, createdAt, extras), handle: 'ada',
  });
  batch.set(doc(db, 'userSearch', ALICE), {
    handle: 'ada', nameLower: 'alice ada',
  });
  return batch.commit();
};

/** The new worst case: leave, delist and take both shelves down, one batch. */
const privateExit = (db, count, createdAt, extras = {}) => {
  const batch = writeBatch(db);
  batch.set(doc(db, 'userProfiles', ALICE), {
    ...profileBody(count, createdAt, extras), visibility: 'private',
  });
  batch.delete(doc(db, 'userSearch', ALICE));
  batch.delete(likesShelf(db));
  batch.delete(savedShelf(db));
  return batch.commit();
};

// ---------------------------------------------------------------------------
// M1 — the shipped pin cap of six still passes every legitimate write.
// ---------------------------------------------------------------------------

test('M1: at six pins, every legitimate write passes under the candidate', async () => {
  const env = await envFor(CANDIDATE, 'm1');
  const runs = [
    ['ordinary save, no toggles touched', {}, (db, at) => ordinarySave(db, 6, at)],
    ['ordinary save, both shelves live', { shelves: true },
      (db, at) => ordinarySave(db, 6, at)],
    ['ordinary save, followers hidden', { extras: { showFollowers: false } },
      (db, at) => ordinarySave(db, 6, at, { showFollowers: false })],
    ['handle rename, both shelves live', { shelves: true },
      (db, at) => renameAtCap(db, 6, at)],
    ['handle rename, followers hidden', { extras: { showFollowers: false }, shelves: true },
      (db, at) => renameAtCap(db, 6, at, { showFollowers: false })],
    ['going private: delist + drop shelves', { shelves: true },
      (db, at) => privateExit(db, 6, at)],
  ];
  for (const [label, opts, write] of runs) {
    const createdAt = await seed(env, 6, opts);
    const db = env.authenticatedContext(ALICE).firestore();
    const ok = await allowed(() => write(db, createdAt));
    console.log(`  @6 pins  ${label.padEnd(40)} -> ${ok ? 'allowed' : 'REFUSED'}`);
    assert.equal(ok, true, `${label} must pass at the shipped cap`);
  }
});

// ---------------------------------------------------------------------------
// M2 — the real ceiling, rules genuinely validating N pins.
// ---------------------------------------------------------------------------

test('M2: pin ceiling, shipping vs candidate', async () => {
  const table = [];
  for (let size = 5; size <= 8; size += 1) {
    const row = { size };
    {
      const env = await envFor(withPinCap(SHIPPING, size), `m2s-${size}`);
      let createdAt = await seed(env, size);
      let db = env.authenticatedContext(ALICE).firestore();
      const save = await allowed(() => ordinarySave(db, size, createdAt));
      createdAt = await seed(env, size);
      db = env.authenticatedContext(ALICE).firestore();
      const rename = await allowed(() => renameAtCap(db, size, createdAt));
      row.shipping = { save, rename };
    }
    {
      const env = await envFor(withPinCap(CANDIDATE, size), `m2c-${size}`);
      let createdAt = await seed(env, size, { shelves: true });
      let db = env.authenticatedContext(ALICE).firestore();
      const save = await allowed(() => ordinarySave(db, size, createdAt));
      createdAt = await seed(env, size, { shelves: true });
      db = env.authenticatedContext(ALICE).firestore();
      const rename = await allowed(() => renameAtCap(db, size, createdAt));
      createdAt = await seed(env, size, { shelves: true });
      db = env.authenticatedContext(ALICE).firestore();
      const exit = await allowed(() => privateExit(db, size, createdAt));
      row.candidate = { save, rename, exit };
    }
    table.push(row);
  }
  console.log('\n[N pins genuinely validated — shipping save/rename | candidate save/rename/private-exit]');
  for (const row of table) {
    const s = row.shipping; const c = row.candidate;
    console.log(`  ${String(row.size).padStart(2)} pins   shipping: ${s.save ? 'ok' : 'NO'}/${s.rename ? 'ok' : 'NO'}`
      + `   candidate: ${c.save ? 'ok' : 'NO'}/${c.rename ? 'ok' : 'NO'}/${c.exit ? 'ok' : 'NO'}`);
  }
  const ceiling = (pick) => table.filter(pick).map(r => r.size).pop() ?? 0;
  console.log(`  ceiling  shipping save/rename: ${ceiling(r => r.shipping.save)}/${ceiling(r => r.shipping.rename)}`
    + `   candidate save/rename/exit: ${ceiling(r => r.candidate.save)}`
    + `/${ceiling(r => r.candidate.rename)}/${ceiling(r => r.candidate.exit)}`);
  assert.equal(table[1].candidate.save, true, 'six pins must keep saving');
  assert.equal(table[1].candidate.rename, true, 'six pins must keep renaming');
  assert.equal(table[1].candidate.exit, true, 'six pins must keep leaving');
});

// ---------------------------------------------------------------------------
// M3 — how many cards fit in one shelf's own evaluation.
// ---------------------------------------------------------------------------

test('M3: shelf ceiling, one shelf at N cards', async () => {
  const results = [];
  for (const size of [4, 6, 8, 10, 12]) {
    const env = await envFor(withShelfCap(CANDIDATE, size), `m3-${size}`);
    await seed(env, 0);
    const db = env.authenticatedContext(ALICE).firestore();
    const ok = await allowed(() => setDoc(likesShelf(db), {
      entries: cards(size), updatedAt: serverTimestamp(),
    }));
    results.push({ size, ok });
    console.log(`  one shelf @ ${String(size).padStart(2)} cards -> ${ok ? 'allowed' : 'REFUSED'}`);
  }
  const ceiling = results.filter(r => r.ok).map(r => r.size).pop() ?? 0;
  console.log(`  ceiling (cards per shelf): ${ceiling}`);
  assert.ok(ceiling >= 6, 'the proposed cap of 6 must fit with slack above it');
});

// ---------------------------------------------------------------------------
// M4 — follows: the one-rule split between directions actually works.
// ---------------------------------------------------------------------------

test('M4: follows matrix under the candidate', async () => {
  const env = await envFor(CANDIDATE, 'm4');

  const matrix = async (label, extras) => {
    await seed(env, 0, { extras, edge: true });
    const cara = env.authenticatedContext(CARA).firestore();
    const aliceDb = env.authenticatedContext(ALICE).firestore();
    const bobDb = env.authenticatedContext(BOB).firestore();
    const anon = env.unauthenticatedContext().firestore();

    const followersOf = db => getDocs(query(
      collection(db, 'follows'), where('targetUid', '==', ALICE), limit(30),
    ));
    const followingOf = db => getDocs(query(
      collection(db, 'follows'), where('followerUid', '==', BOB), limit(30),
    ));
    const followerCount = db => getCountFromServer(query(
      collection(db, 'follows'), where('targetUid', '==', ALICE), limit(1000),
    ));
    const followingCount = db => getCountFromServer(query(
      collection(db, 'follows'), where('followerUid', '==', BOB), limit(1000),
    ));
    const edgeGet = db => getDoc(doc(db, 'follows', `${BOB}_${ALICE}`)).then((snap) => {
      if (!snap.exists()) throw new Error('missing');
    });

    const row = {
      strangerList: await allowed(() => followersOf(cara)),
      anonList: await allowed(() => followersOf(anon)),
      ownerList: await allowed(() => followersOf(aliceDb)),
      strangerCount: await allowed(() => followerCount(cara)),
      ownerCount: await allowed(() => followerCount(aliceDb)),
      followingList: await allowed(() => followingOf(cara)),
      anonFollowingList: await allowed(() => followingOf(anon)),
      followingCount: await allowed(() => followingCount(cara)),
      strangerGet: await allowed(() => edgeGet(cara)),
      followerGet: await allowed(() => edgeGet(bobDb)),
      targetGet: await allowed(() => edgeGet(aliceDb)),
    };
    console.log(`  [${label}]`);
    for (const [k, v] of Object.entries(row)) {
      console.log(`    ${k.padEnd(18)} -> ${v ? 'allowed' : 'denied'}`);
    }
    return row;
  };

  const open = await matrix('showFollowers absent (deploy safety)', {});
  assert.deepEqual(open, {
    strangerList: true, anonList: true, ownerList: true,
    strangerCount: true, ownerCount: true,
    followingList: true, anonFollowingList: true, followingCount: true,
    strangerGet: true, followerGet: true, targetGet: true,
  }, 'with the flag absent, nothing changes for anyone');

  const closed = await matrix('showFollowers: false', { showFollowers: false });
  assert.deepEqual(closed, {
    strangerList: false, anonList: false, ownerList: true,
    strangerCount: false, ownerCount: true,
    followingList: true, anonFollowingList: true, followingCount: true,
    strangerGet: false, followerGet: true, targetGet: true,
  }, 'the followers direction closes; the following direction stays open');

  // Following someone whose follower list is private must still be possible:
  // the toggle hides the list, it does not make the account unfollowable.
  await seed(env, 0, { extras: { showFollowers: false } });
  const cara = env.authenticatedContext(CARA).firestore();
  const canFollow = await allowed(() => setDoc(doc(cara, 'follows', `${CARA}_${ALICE}`), {
    followerUid: CARA, targetUid: ALICE, createdAt: serverTimestamp(),
  }));
  console.log(`  follow a flag-off account            -> ${canFollow ? 'allowed' : 'REFUSED'}`);
  assert.equal(canFollow, true);
});

// ---------------------------------------------------------------------------
// M5 — shelf lifecycle: every stale-artifact hole closed, legit paths open.
// ---------------------------------------------------------------------------

test('M5: shelf lifecycle under the candidate', async () => {
  const env = await envFor(CANDIDATE, 'm5');

  // Turning likes on is just writing the shelf; no profile write involved.
  await seed(env, 0);
  let db = env.authenticatedContext(ALICE).firestore();
  const turnOn = await allowed(() => setDoc(likesShelf(db), {
    entries: cards(6), updatedAt: serverTimestamp(),
  }));
  console.log(`  publish the likes shelf                        -> ${turnOn ? 'allowed' : 'REFUSED'}`);
  assert.equal(turnOn, true);

  // Turning it off is deleting the shelf.
  const turnOff = await allowed(() => deleteShelf(db));
  function deleteShelf(database) {
    const batch = writeBatch(database);
    batch.delete(likesShelf(database));
    return batch.commit();
  }
  console.log(`  retire the likes shelf                         -> ${turnOff ? 'allowed' : 'REFUSED'}`);
  assert.equal(turnOff, true);

  // No shelf on a private profile; no shelf named anything else; no writing
  // someone else's shelf; no oversized shelf.
  await seed(env, 0, { extras: { visibility: 'private' }, indexed: false });
  db = env.authenticatedContext(ALICE).firestore();
  const whilePrivate = await allowed(() => setDoc(likesShelf(db), {
    entries: cards(3), updatedAt: serverTimestamp(),
  }));
  await seed(env, 0);
  db = env.authenticatedContext(ALICE).firestore();
  const wrongName = await allowed(() => setDoc(
    doc(db, 'profileShowcase', ALICE, 'shelves', 'browsing-history'),
    { entries: cards(3), updatedAt: serverTimestamp() },
  ));
  const mallory = env.authenticatedContext(CARA).firestore();
  const someoneElses = await allowed(() => setDoc(likesShelf(mallory), {
    entries: cards(3), updatedAt: serverTimestamp(),
  }));
  const oversized = await allowed(() => setDoc(likesShelf(db), {
    entries: cards(7), updatedAt: serverTimestamp(),
  }));
  console.log(`  shelf on a private profile                     -> ${whilePrivate ? 'ALLOWED (hole)' : 'denied'}`);
  console.log(`  shelf under an unknown name                    -> ${wrongName ? 'ALLOWED (hole)' : 'denied'}`);
  console.log(`  writing someone else's shelf                   -> ${someoneElses ? 'ALLOWED (hole)' : 'denied'}`);
  console.log(`  seven cards on a six-card shelf                -> ${oversized ? 'ALLOWED (hole)' : 'denied'}`);
  assert.equal(whilePrivate, false);
  assert.equal(wrongName, false);
  assert.equal(someoneElses, false);
  assert.equal(oversized, false);

  // Going private with a shelf still standing: refused. Deleting the profile
  // with a shelf still standing: refused.
  let createdAt = await seed(env, 0, { shelves: true });
  db = env.authenticatedContext(ALICE).firestore();
  const privateStale = await allowed(() => {
    const batch = writeBatch(db);
    batch.update(doc(db, 'userProfiles', ALICE), {
      visibility: 'private', updatedAt: serverTimestamp(),
    });
    batch.delete(doc(db, 'userSearch', ALICE));
    return batch.commit();
  });
  createdAt = await seed(env, 0, { shelves: true });
  db = env.authenticatedContext(ALICE).firestore();
  const deleteStale = await allowed(() => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'userProfiles', ALICE));
    batch.delete(doc(db, 'handles', 'alice'));
    batch.delete(doc(db, 'userSearch', ALICE));
    return batch.commit();
  });
  console.log(`  going private, shelf left standing             -> ${privateStale ? 'ALLOWED (hole)' : 'denied'}`);
  console.log(`  profile delete, shelf left standing            -> ${deleteStale ? 'ALLOWED (hole)' : 'denied'}`);
  assert.equal(privateStale, false);
  assert.equal(deleteStale, false);

  // The full round trip: leave with everything in one batch, come back and
  // republish in one batch.
  createdAt = await seed(env, 0, { shelves: true });
  db = env.authenticatedContext(ALICE).firestore();
  const exitOk = await allowed(() => privateExit(db, 0, createdAt));
  const comeBack = exitOk && await allowed(() => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'userProfiles', ALICE), profileBody(0, createdAt));
    batch.set(doc(db, 'userSearch', ALICE), {
      handle: 'alice', nameLower: 'alice ada',
    });
    batch.set(likesShelf(db), { entries: cards(6), updatedAt: serverTimestamp() });
    batch.set(savedShelf(db), { entries: cards(6), updatedAt: serverTimestamp() });
    return batch.commit();
  });
  console.log(`  private exit, one batch                        -> ${exitOk ? 'allowed' : 'REFUSED'}`);
  console.log(`  return to public, shelves republished          -> ${comeBack ? 'allowed' : 'REFUSED'}`);
  assert.equal(exitOk, true);
  assert.equal(comeBack, true);

  // Anyone may read a live shelf; nobody may page the collection.
  await seed(env, 0, { shelves: true });
  const anon = env.unauthenticatedContext().firestore();
  const anonGet = await allowed(() => getDoc(likesShelf(anon)));
  const anonList = await allowed(() => getDocs(query(
    collection(anon, 'profileShowcase', ALICE, 'shelves'), limit(5),
  )));
  console.log(`  signed-out get of a live shelf                 -> ${anonGet ? 'allowed' : 'REFUSED'}`);
  console.log(`  paging the shelves collection                  -> ${anonList ? 'ALLOWED (hole)' : 'denied'}`);
  assert.equal(anonGet, true);
  assert.equal(anonList, false);

  // Legacy path: an account with no flag and no shelves keeps saving, and
  // its search-index writes keep working (the P16 contract).
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const fs = context.firestore();
    await setDoc(doc(fs, 'userProfiles', ALICE), {
      handle: 'alice', displayName: 'Alice Ada', pinnedLists: [],
      createdAt: new Date(), updatedAt: new Date(),
    });
    await setDoc(doc(fs, 'handles', 'alice'), { uid: ALICE, createdAt: new Date() });
  });
  db = env.authenticatedContext(ALICE).firestore();
  const legacy = await allowed(() => updateDoc(doc(db, 'userProfiles', ALICE), {
    displayName: 'Alice B', updatedAt: serverTimestamp(),
  }));
  console.log(`  legacy account, no flag, ordinary update       -> ${legacy ? 'allowed' : 'REFUSED'}`);
  assert.equal(legacy, true);
});
