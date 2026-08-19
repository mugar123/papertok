import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InvalidHandleError } from '../utils/userHandle.js';
import {
  HandleUnavailableError,
  PINNABLE_LISTS_PAGE_SIZE,
  USER_PROFILE_LIMITS,
  UserProfileUnsupportedError,
  changeUserHandle,
  createUserProfile,
  deleteOwnUserProfile,
  partitionStalePins,
  pinListEntry,
  publicAvatarFrom,
  readOwnLists,
  readPinnableLists,
  readUserProfile,
  readUserProfileByHandle,
  sanitizePinnedList,
  sanitizePinnedLists,
  sanitizeUserProfile,
  savePinnedLists,
  savePublicProfilePhoto,
  unpinListEntry,
  updateUserProfile,
} from './userProfileService.js';

const SHARE_ID = 'a'.repeat(32);
const OTHER_SHARE_ID = 'b'.repeat(32);

async function loadRules() {
  return readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
}

function ruleBlock(rules, path) {
  const escaped = path.replace(/[/{}]/g, character => `\\${character}`);
  return rules.match(new RegExp(`match ${escaped} \\{[\\s\\S]*?\\n {4}\\}`))?.[0] || '';
}

function fakeApi(overrides = {}) {
  const calls = [];
  const batch = {
    set: (...args) => calls.push(['set', ...args]),
    update: (...args) => calls.push(['update', ...args]),
    delete: (...args) => calls.push(['delete', ...args]),
    commit: async () => { calls.push(['commit']); },
  };
  return {
    calls,
    api: {
      database: 'db',
      currentUser: { uid: 'user-1' },
      document: (...parts) => parts.join('/'),
      batch: () => batch,
      deleteValue: () => 'DELETE_FIELD',
      now: () => 'SERVER_TIME',
      getDocument: async () => ({ exists: () => false }),
      isDemo: false,
      ...overrides,
    },
  };
}

function writtenPaths(calls) {
  return calls.filter(([kind]) => kind !== 'commit').map(([, reference]) => reference);
}

// --- shape of what leaves the client -------------------------------------

test('keeps the public profile to the client-writable contract', () => {
  const result = sanitizeUserProfile({
    displayName: '  Ada   Lovelace ',
    bio: 'Analytical engine notes.\r\nSecond line.',
    allowContact: true,
    pinnedLists: [{ shareId: SHARE_ID, name: 'Reading', emoji: '📚', paperIds: [1, 2, 3] }],
    // Everything below is either private or service-owned and must not survive.
    orcid: '0000-0002-1825-0097',
    verified: true,
    email: 'ada@example.test',
    photo: 'https://evil.example/tracker.gif',
    followerCount: 9001,
  });

  assert.deepEqual(Object.keys(result).sort(), ['allowContact', 'bio', 'displayName', 'pinnedLists']);
  assert.equal(result.displayName, 'Ada Lovelace');
  assert.equal(result.bio, 'Analytical engine notes.\nSecond line.');
  assert.deepEqual(result.pinnedLists, [
    { shareId: SHARE_ID, title: 'Reading', emoji: '📚', paperCount: 3 },
  ]);
});

test('a client can never write orcid or verified', () => {
  // These two carry the trust signal in F6; a self-serve write would make
  // verification meaningless.
  for (const field of ['orcid', 'verified']) {
    const result = sanitizeUserProfile({ displayName: 'Ada', [field]: 'anything' });
    assert.equal(field in result, false, `${field} must not survive sanitization`);
  }
});

test('accepts only a recompressed inline photo', () => {
  const good = `data:image/webp;base64,${'A'.repeat(64)}`;
  assert.equal(sanitizeUserProfile({ displayName: 'Ada', photo: good }).photo, good);
  for (const bad of [
    'https://cdn.example/photo.png',
    `data:image/svg+xml;base64,${'A'.repeat(64)}`,
    `data:image/png;base64,${'A'.repeat(USER_PROFILE_LIMITS.photo + 10)}`,
  ]) {
    assert.equal('photo' in sanitizeUserProfile({ displayName: 'Ada', photo: bad }), false);
  }
});

test('a pinned list card is a share id, a title and a count — nothing else', () => {
  const pinned = sanitizePinnedList({
    shareId: SHARE_ID.toUpperCase(),
    title: 'Reading',
    paperCount: 4,
    papers: [{ title: 'secret' }],
    ownerId: 'user-1',
  });
  assert.deepEqual(pinned, { shareId: SHARE_ID, title: 'Reading', paperCount: 4 });
  assert.equal(sanitizePinnedList({ shareId: 'not-a-share-id', title: 'x' }), null);
  assert.equal(sanitizePinnedList({ shareId: SHARE_ID, title: '   ' }), null);
});

// --- pinning ---------------------------------------------------------------

test('pinning and unpinning a list is idempotent and bounded', () => {
  const first = pinListEntry([], { shareId: SHARE_ID, title: 'Reading', paperCount: 2 });
  assert.equal(first.length, 1);

  const again = pinListEntry(first, { shareId: SHARE_ID, title: 'Reading renamed', paperCount: 3 });
  assert.equal(again.length, 1, 'pinning the same list twice must not duplicate it');
  assert.equal(again[0].title, 'Reading renamed');

  const two = pinListEntry(again, { shareId: OTHER_SHARE_ID, title: 'Second', paperCount: 1 });
  assert.deepEqual(unpinListEntry(two, SHARE_ID).map(item => item.shareId), [OTHER_SHARE_ID]);
  assert.deepEqual(unpinListEntry(two, SHARE_ID.toUpperCase()).map(item => item.shareId), [OTHER_SHARE_ID]);
  assert.deepEqual(unpinListEntry(two, 'unknown'), two);
});

test('refuses to pin past the documented ceiling', () => {
  const full = Array.from({ length: USER_PROFILE_LIMITS.pinnedLists }, (_, index) => ({
    shareId: index.toString(16).padStart(32, '0'),
    title: `List ${index}`,
    paperCount: 0,
  }));
  assert.throws(
    () => pinListEntry(full, { shareId: SHARE_ID, title: 'One too many', paperCount: 0 }),
    RangeError,
  );
});

test('pinning writes the profile and NOTHING in publicLists', async () => {
  // Attribution is opt-in precisely because the public list documents stay
  // anonymous. A write here would undo that.
  const { api, calls } = fakeApi();
  await savePinnedLists([{ shareId: SHARE_ID, title: 'Reading', paperCount: 2 }], api);

  assert.deepEqual(writtenPaths(calls), ['db/userProfiles/user-1']);
  for (const path of writtenPaths(calls)) {
    assert.doesNotMatch(path, /publicList/i);
  }
  const [, , payload] = calls[0];
  assert.deepEqual(Object.keys(payload).sort(), ['pinnedLists', 'updatedAt']);
});

test('unpinning writes the profile and NOTHING in publicLists', async () => {
  const { api, calls } = fakeApi();
  const remaining = unpinListEntry(
    [{ shareId: SHARE_ID, title: 'Reading', paperCount: 2 }],
    SHARE_ID,
  );
  await savePinnedLists(remaining, api);

  assert.deepEqual(writtenPaths(calls), ['db/userProfiles/user-1']);
  assert.deepEqual(calls[0][2].pinnedLists, []);
});

// --- handle reservation ----------------------------------------------------

test('creating a profile reserves the handle in the same batch', async () => {
  const { api, calls } = fakeApi();
  await createUserProfile({ handle: '  @Ada  ', displayName: 'Ada Lovelace' }, api);

  assert.deepEqual(writtenPaths(calls), ['db/userProfiles/user-1', 'db/handles/ada']);
  assert.equal(calls.at(-1)[0], 'commit', 'both writes must land in one commit');
  assert.equal(calls[0][2].handle, 'ada');
  assert.deepEqual(calls[1][2], { uid: 'user-1', createdAt: 'SERVER_TIME' });
});

test('an invalid or reserved handle never reaches Firestore', async () => {
  for (const handle of ['admin', 'settings', 'ab', 'ada lovelace', '123']) {
    const { api, calls } = fakeApi();
    await assert.rejects(
      () => createUserProfile({ handle, displayName: 'Ada' }, api),
      InvalidHandleError,
      `${handle} should be refused before any write`,
    );
    assert.deepEqual(calls, [], 'nothing may be written for an invalid handle');
  }
});

test('a taken handle surfaces as a collision, not a generic failure', async () => {
  // The rules make handles/{handle} create-only, so the losing side of a race
  // gets permission-denied. The UI needs to tell that apart from a bug.
  const denied = Object.assign(new Error('denied'), { code: 'permission-denied' });
  const { api } = fakeApi({
    batch: () => ({
      set: () => {}, update: () => {}, delete: () => {},
      commit: async () => { throw denied; },
    }),
  });
  await assert.rejects(
    () => createUserProfile({ handle: 'ada', displayName: 'Ada' }, api),
    (error) => error instanceof HandleUnavailableError && error.handle === 'ada',
  );
});

test('changing a handle frees the old one and claims the new one in one batch', async () => {
  const { api, calls } = fakeApi();
  await changeUserHandle('Grace', 'ada', api);

  assert.deepEqual(calls.map(([kind]) => kind), ['delete', 'set', 'update', 'commit']);
  assert.deepEqual(writtenPaths(calls), [
    'db/handles/ada', 'db/handles/grace', 'db/userProfiles/user-1',
  ]);
  assert.equal(calls[2][2].handle, 'grace');
});

test('changing a handle to the same handle writes nothing', async () => {
  const { api, calls } = fakeApi();
  const result = await changeUserHandle('  @ADA ', 'ada', api);
  assert.equal(result.changed, false);
  assert.deepEqual(calls, []);
});

test('profile writes require a session and a non-demo project', async () => {
  const { api: anonymous } = fakeApi({ currentUser: null });
  await assert.rejects(() => createUserProfile({ handle: 'ada', displayName: 'Ada' }, anonymous));
  await assert.rejects(() => updateUserProfile({ displayName: 'Ada' }, anonymous));

  const { api: demo } = fakeApi({ isDemo: true });
  await assert.rejects(
    () => createUserProfile({ handle: 'ada', displayName: 'Ada' }, demo),
    UserProfileUnsupportedError,
  );
});

// --- reads -----------------------------------------------------------------

test('a profile visit is one read, and a handle visit is two', async () => {
  const reads = [];
  const documents = {
    'db/handles/ada': { uid: 'user-1' },
    'db/userProfiles/user-1': { handle: 'ada', displayName: 'Ada', pinnedLists: [] },
  };
  const api = fakeApi({
    currentUser: null,
    getDocument: async (path) => {
      reads.push(path);
      const data = documents[path];
      return { exists: () => Boolean(data), id: path.split('/').pop(), data: () => data };
    },
  }).api;

  await readUserProfile('user-1', api);
  assert.equal(reads.length, 1, 'the pinned lists are embedded, so the profile is one read');

  reads.length = 0;
  const profile = await readUserProfileByHandle('  @ADA ', api);
  assert.deepEqual(reads, ['db/handles/ada', 'db/userProfiles/user-1']);
  assert.equal(profile.uid, 'user-1');
});

test('a reservation pointing at a profile that moved on resolves to nothing', async () => {
  const documents = {
    'db/handles/ada': { uid: 'user-1' },
    'db/userProfiles/user-1': { handle: 'grace', displayName: 'Grace', pinnedLists: [] },
  };
  const api = fakeApi({
    currentUser: null,
    getDocument: async (path) => {
      const data = documents[path];
      return { exists: () => Boolean(data), id: path.split('/').pop(), data: () => data };
    },
  }).api;
  assert.equal(await readUserProfileByHandle('ada', api), null);
});

test('reading a profile never requires a signed-in user', async () => {
  const api = fakeApi({
    currentUser: null,
    getDocument: async () => ({
      exists: () => true,
      id: 'user-1',
      data: () => ({ handle: 'ada', displayName: 'Ada', pinnedLists: [] }),
    }),
  }).api;
  const profile = await readUserProfile('user-1', api);
  assert.equal(profile.handle, 'ada');
});

// --- the rules that back all of the above ---------------------------------
// These read firestore.rules as text: they pin the guarantees the service
// depends on, and they fail if the corresponding clause is removed. They do
// not execute the rules — that needs the emulator, which needs a JRE that is
// not installed on this machine.

test('RULES: a profile is fetchable without a session but not listable', async () => {
  const block = ruleBlock(await loadRules(), '/userProfiles/{profileUid}');
  assert.ok(block, 'firestore.rules must declare userProfiles');
  assert.match(block, /allow get: if true/);
  assert.match(block, /allow list: if false/);
  // `read` would silently re-grant `list` and reopen the directory dump.
  assert.doesNotMatch(block, /allow read/);
});

test('RULES: a handle resolves without a session, and is create-only', async () => {
  const block = ruleBlock(await loadRules(), '/handles/{handle}');
  assert.ok(block, 'firestore.rules must declare handles');
  assert.match(block, /allow get: if true/);
  assert.match(block, /allow list: if false/);
  assert.doesNotMatch(block, /allow read/);
  // No update rule is the uniqueness guarantee: an occupied handle cannot be
  // overwritten, so a `set` over someone else's reservation is denied.
  assert.doesNotMatch(block, /allow (update|write)/);
  assert.doesNotMatch(block, /allow create[\s\S]*?allow create/);
});

test('RULES: a user cannot write another user\'s profile', async () => {
  const block = ruleBlock(await loadRules(), '/userProfiles/{profileUid}');
  const writes = block.match(/allow (create|update|delete):[\s\S]*?(?=\n {6}allow |\n {4}\})/g) || [];
  assert.equal(writes.length, 3, 'create, update and delete must each be constrained');
  for (const clause of writes) {
    assert.match(clause, /request\.auth\.uid == profileUid/, `unguarded write clause: ${clause}`);
  }
});

test('RULES: a user cannot claim a handle for someone else', async () => {
  const block = ruleBlock(await loadRules(), '/handles/{handle}');
  assert.match(block, /request\.resource\.data\.uid == request\.auth\.uid/);
  // The reservation and the profile have to agree inside the same batch.
  assert.match(block, /getAfter\([\s\S]*?userProfiles\/\$\(request\.auth\.uid\)[\s\S]*?\)\.data\.handle == handle/);
  assert.match(block, /allow delete: if \(request\.auth != null\s*&& resource\.data\.uid == request\.auth\.uid\)/);
});

test('RULES: a profile cannot claim a handle it does not hold', async () => {
  const block = ruleBlock(await loadRules(), '/userProfiles/{profileUid}');
  // Create: the reservation must exist after the batch.
  assert.match(block, /existsAfter\(\s*\/databases\/\$\(database\)\/documents\/handles\/\$\(request\.resource\.data\.handle\)\s*\)/);
  // Update: a handle change must both claim the new one and free the old one.
  assert.match(block, /getAfter\([\s\S]*?handles\/\$\(request\.resource\.data\.handle\)[\s\S]*?\)\.data\.uid == request\.auth\.uid/);
  assert.match(block, /!existsAfter\(\s*\/databases\/\$\(database\)\/documents\/handles\/\$\(resource\.data\.handle\)\s*\)/);
});

test('RULES: a client cannot set orcid or verified on itself', async () => {
  const rules = await loadRules();
  const block = ruleBlock(rules, '/userProfiles/{profileUid}');
  assert.match(block, /publicProfileServiceFieldsAbsent\(\)/);
  assert.match(block, /publicProfileServiceFieldsUnchanged\(\)/);
  assert.match(rules, /function publicProfileServiceFieldsAbsent\(\) \{[\s\S]*?!\('orcid' in request\.resource\.data\)/);
  assert.match(rules, /function publicProfileServiceFieldsUnchanged\(\) \{[\s\S]*?request\.resource\.data\.verified == resource\.data\.verified/);
});

test('RULES: pinned lists are bounded, owned, and carry no paper payload', async () => {
  const rules = await loadRules();
  assert.match(rules, /entries\.size\(\) <= 6/);
  assert.match(rules, /entry\.keys\(\)\.hasOnly\(\['shareId', 'title', 'emoji', 'paperCount'\]\)/);
  assert.match(rules, /entry\.shareId\.matches\('\^\[a-f0-9\]\{32\}\$'\)/);
  // Without this a share id is only checked for shape, so anyone could pin
  // somebody else's list and claim the attribution.
  assert.match(rules, /&& ownsPinnedShare\(entry\.shareId\)/);
  assert.match(rules, /function ownsPinnedShare\(shareId\) \{[\s\S]*?publicListOwners\/\$\(shareId\)[\s\S]*?\.data\.ownerId == request\.auth\.uid/);
});

test('RULES: deleting a profile must free its handle', async () => {
  const block = ruleBlock(await loadRules(), '/userProfiles/{profileUid}');
  const del = block.match(/allow delete:[\s\S]*?(?=\n {4}\})/)?.[0] || '';
  assert.match(del, /!existsAfter\(\s*\/databases\/\$\(database\)\/documents\/handles\/\$\(resource\.data\.handle\)\s*\)/);
});

test('RULES: followerCount is service-only, like orcid and verified', async () => {
  const rules = await loadRules();
  assert.match(rules, /function publicProfileServiceFieldsAbsent\(\) \{[\s\S]*?!\('followerCount' in request\.resource\.data\)/);
  assert.match(rules, /function publicProfileServiceFieldsUnchanged\(\) \{[\s\S]*?request\.resource\.data\.followerCount == resource\.data\.followerCount/);
});

test('RULES: the publicLists and publicListOwners blocks are byte-for-byte untouched', async () => {
  // F1 attributes lists by pinning, so neither block may change: public lists
  // stay anonymous, and no existing document grows an owner field. These are
  // the two blocks exactly as they stood before this phase.
  const rules = await loadRules();
  assert.equal(
    ruleBlock(rules, '/publicLists/{shareId}'),
    "match /publicLists/{shareId} {\n      allow read: if true;\n      allow create: if ownsPublicListAfter(shareId)\n        && request.resource.data.createdAt == request.time\n        && request.resource.data.updatedAt == request.time\n        && validPublicList();\n      allow update: if ownsPublicList(shareId)\n        && request.resource.data.createdAt == resource.data.createdAt\n        && request.resource.data.updatedAt == request.time\n        && validPublicList();\n      allow delete: if ownsPublicList(shareId);\n    }",
  );
  assert.equal(
    ruleBlock(rules, '/publicListOwners/{shareId}'),
    "match /publicListOwners/{shareId} {\n      allow create: if request.auth != null\n        && request.resource.data.keys().hasOnly(['ownerId', 'listId', 'createdAt'])\n        && request.resource.data.ownerId == request.auth.uid\n        && validString(request.resource.data.listId, 160)\n        && request.resource.data.listId.size() > 0\n        && request.resource.data.createdAt == request.time\n        && getAfter(\n          /databases/$(database)/documents/users/$(request.auth.uid)/lists/$(request.resource.data.listId)\n        ).data.publicShareId == shareId;\n      allow delete: if ownsPublicList(shareId);\n    }",
  );
});

// --- the pin picker's read -------------------------------------------------

test('the pin picker reads a bounded page of published lists only', async () => {
  const requested = [];
  const { api } = fakeApi({
    publishedLists: async (database, uid, pageSize) => {
      requested.push({ database, uid, pageSize });
      return [
        { id: 'l1', name: 'Reading', emoji: '📚', paperIds: [1, 2], publicShareId: SHARE_ID },
        { id: 'l2', name: 'Private', paperIds: [1] },
        { id: 'l3', name: 'Second', paperIds: [], publicShareId: OTHER_SHARE_ID },
      ];
    },
  });

  const pinnable = await readPinnableLists(api);
  assert.deepEqual(requested, [{ database: 'db', uid: 'user-1', pageSize: PINNABLE_LISTS_PAGE_SIZE }]);
  assert.ok(Number.isInteger(PINNABLE_LISTS_PAGE_SIZE) && PINNABLE_LISTS_PAGE_SIZE > 0);
  assert.deepEqual(pinnable, [
    { shareId: SHARE_ID, title: 'Reading', emoji: '📚', paperCount: 2 },
    { shareId: OTHER_SHARE_ID, title: 'Second', paperCount: 0 },
  ]);
});

test('an over-long page from Firestore is still capped client-side', async () => {
  const { api } = fakeApi({
    publishedLists: async () => Array.from({ length: 500 }, (_, index) => ({
      id: `l${index}`,
      name: `List ${index}`,
      paperIds: [],
      publicShareId: index.toString(16).padStart(32, '0'),
    })),
  });
  assert.equal((await readPinnableLists(api)).length, PINNABLE_LISTS_PAGE_SIZE);
});

test('SOURCE: no collection in this service is read without a limit', async () => {
  // A recent bug was exactly this shape: a collection read with no ceiling.
  const source = await readFile(new URL('./userProfileService.js', import.meta.url), 'utf8');
  const collectionReads = source.match(/getDocs\(query\([\s\S]*?\)\)/g) || [];
  assert.ok(collectionReads.length > 0, 'expected at least one collection read to guard');
  for (const read of collectionReads) {
    assert.match(read, /limit\(/, `unbounded collection read: ${read}`);
  }
  assert.doesNotMatch(source, /getDocs\((?!query\()/, 'every getDocs must go through a bounded query');
});

// --- stale pins ------------------------------------------------------------

test('splits pins into the ones still published and the ones that are not', () => {
  // Unpublishing deletes publicListOwners/{shareId}, which is what the rules
  // read to prove ownership — so a stale pin blocks every profile write until
  // it is dropped.
  const pins = [
    { shareId: SHARE_ID, title: 'Live', paperCount: 2 },
    { shareId: OTHER_SHARE_ID, title: 'Unpublished', paperCount: 1 },
  ];
  const published = [{ shareId: SHARE_ID, title: 'Live', paperCount: 2 }];

  const { pinned, stale } = partitionStalePins(pins, published);
  assert.deepEqual(pinned.map(p => p.shareId), [SHARE_ID]);
  assert.deepEqual(stale.map(p => p.shareId), [OTHER_SHARE_ID]);
});

test('with nothing published, every pin is stale', () => {
  const pins = [{ shareId: SHARE_ID, title: 'Live', paperCount: 2 }];
  assert.deepEqual(partitionStalePins(pins, []).pinned, []);
  assert.equal(partitionStalePins(pins, []).stale.length, 1);
  assert.deepEqual(partitionStalePins([], []), { pinned: [], stale: [] });
});

test('the pin ceiling matches the expression budget in the rules', () => {
  // Measured against the emulator, not reasoned about: eight pinned entries
  // exceed the 1000-expression limit per rule evaluation. Six is seven minus a
  // margin. Raise it here and `npm run test:rules` fails.
  assert.equal(USER_PROFILE_LIMITS.pinnedLists, 6);
  const tooMany = Array.from({ length: 9 }, (_, index) => ({
    shareId: index.toString(16).padStart(32, '0'),
    title: `List ${index}`,
    paperCount: 0,
  }));
  assert.equal(sanitizePinnedLists(tooMany).length, 6);
});

test('a pinned card cannot claim more papers than a public list can hold', () => {
  assert.equal(sanitizePinnedList({ shareId: SHARE_ID, title: 'x', paperCount: 500 }).paperCount, 12);
});

// --- the public avatar -----------------------------------------------------

const GOOGLE_AVATAR = 'https://lh3.googleusercontent.com/a/ACg8ocLoyCJZgVTNsCm0=s96-c';
const INLINE_AVATAR = `data:image/webp;base64,${'A'.repeat(64)}`;

test('mirrors an allowlisted provider avatar URL, since it cannot be recompressed', () => {
  // Google refuses CORS on these, so the browser cannot fetch one into a data
  // URL. Storing the URL is the only way the public profile can show it.
  assert.equal(publicAvatarFrom(null, GOOGLE_AVATAR), GOOGLE_AVATAR);
  assert.equal(publicAvatarFrom('', 'https://lh6.googleusercontent.com/a/x'), 'https://lh6.googleusercontent.com/a/x');
});

test('an uploaded photo beats the provider one', () => {
  assert.equal(publicAvatarFrom(INLINE_AVATAR, GOOGLE_AVATAR), INLINE_AVATAR);
});

test('refuses avatar URLs from anywhere but the allowlist', () => {
  // Otherwise a profile owner could point their avatar at a URL they control
  // and log the IP of everyone who opens their public page.
  for (const url of [
    'https://attacker.example/track.gif',
    'https://evil.googleusercontent.com.attacker.example/x',
    'http://lh3.googleusercontent.com/a/x',
    'https://lh3.googleusercontent.com.attacker.example/x',
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
  ]) {
    assert.equal(publicAvatarFrom(null, url), '', `${url} must not be stored`);
  }
});

test('an uploaded photo past the public budget is not mirrored', () => {
  // The private copy may be up to 280 KB; the public document is read on every
  // profile visit and must not carry it.
  const huge = `data:image/png;base64,${'A'.repeat(USER_PROFILE_LIMITS.photo + 10)}`;
  assert.equal(publicAvatarFrom(huge, null), '');
  assert.equal(publicAvatarFrom(huge, GOOGLE_AVATAR), GOOGLE_AVATAR, 'falls back rather than storing nothing');
});

test('mirroring the avatar writes one field and only when a profile exists', async () => {
  const { api, calls } = fakeApi({
    getDocument: async () => ({ exists: () => true, id: 'user-1', data: () => ({ handle: 'ada' }) }),
  });
  await savePublicProfilePhoto(GOOGLE_AVATAR, api);
  assert.deepEqual(writtenPaths(calls), ['db/userProfiles/user-1']);
  assert.deepEqual(Object.keys(calls[0][2]).sort(), ['photo', 'updatedAt']);
  assert.equal(calls[0][2].photo, GOOGLE_AVATAR);
});

test('clearing the avatar removes the field rather than storing an empty string', async () => {
  const { api, calls } = fakeApi({
    getDocument: async () => ({ exists: () => true, id: 'user-1', data: () => ({ handle: 'ada' }) }),
  });
  await savePublicProfilePhoto(null, api);
  assert.equal(calls[0][2].photo, 'DELETE_FIELD');
});

test('changing a photo never creates a public profile', async () => {
  // Someone who has not opted into a public profile must not get one just by
  // picking an avatar in the general settings screen.
  const { api, calls } = fakeApi({
    getDocument: async () => ({ exists: () => false }),
  });
  assert.equal(await savePublicProfilePhoto(GOOGLE_AVATAR, api), null);
  assert.deepEqual(calls, []);
});

// --- unpublishing the profile ------------------------------------------------

test('deleting the profile frees the handle in the same batch', async () => {
  // The rules refuse a profile delete that leaves the reservation behind
  // (hardening C), so both documents must fall together or the write bounces.
  const { api, calls } = fakeApi({
    getDocument: async () => ({ exists: () => true, id: 'user-1', data: () => ({ handle: 'ada' }) }),
  });
  assert.equal(await deleteOwnUserProfile(api), true);
  const deletes = calls.filter(([kind]) => kind === 'delete').map(([, reference]) => reference);
  assert.deepEqual(deletes.sort(), ['db/handles/ada', 'db/userProfiles/user-1']);
  assert.deepEqual(calls.at(-1), ['commit'], 'both deletes ride one batch');
});

test('deleting without a profile is a no-op, not an error', async () => {
  const { api, calls } = fakeApi({ getDocument: async () => ({ exists: () => false }) });
  assert.equal(await deleteOwnUserProfile(api), false);
  assert.deepEqual(calls, []);
});

test('unpublishing refuses demo mode like every other profile write', async () => {
  const demo = fakeApi({ isDemo: true });
  await assert.rejects(deleteOwnUserProfile(demo.api), UserProfileUnsupportedError);
});

// --- the owner's own list page ---------------------------------------------

test('readOwnLists keeps every list and marks only the published ones', async () => {
  const { api } = fakeApi({
    ownLists: async () => [
      { id: 'a', name: 'Private notes', paperIds: ['x'], createdAt: '2026-08-01T00:00:00Z' },
      { id: 'b', name: 'Shared reading', paperIds: ['x', 'y'], publicShareId: SHARE_ID, createdAt: '2026-08-02T00:00:00Z' },
    ],
  });
  const lists = await readOwnLists(api);
  assert.deepEqual(lists.map(list => [list.id, list.isPublished]), [['b', true], ['a', false]]);
  assert.equal(lists[0].paperCount, 2);
});

test('readOwnLists asks for one bounded page and clamps whatever comes back', async () => {
  let requestedPageSize = null;
  const { api } = fakeApi({
    ownLists: async (database, uid, pageSize) => {
      requestedPageSize = pageSize;
      assert.equal(uid, 'user-1');
      return Array.from({ length: PINNABLE_LISTS_PAGE_SIZE + 20 }, (unused, index) => ({
        id: `l${index}`,
        name: `List ${index}`,
        paperIds: [],
      }));
    },
  });
  const lists = await readOwnLists(api);
  assert.equal(requestedPageSize, PINNABLE_LISTS_PAGE_SIZE);
  assert.equal(lists.length, PINNABLE_LISTS_PAGE_SIZE, 'an over-long page must be clamped');
});

test('readOwnLists orders newest first and survives lists without createdAt', async () => {
  const { api } = fakeApi({
    ownLists: async () => [
      { id: 'old', name: 'Old', paperIds: [], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'undated-b', name: 'Beta', paperIds: [] },
      { id: 'new', name: 'New', paperIds: [], createdAt: { toMillis: () => 1767225600000 } },
      { id: 'undated-a', name: 'Alpha', paperIds: [] },
    ],
  });
  // Dated ones first (newest on top); undated sink to the bottom alphabetically
  // instead of disappearing, which is what an orderBy would have done to them.
  assert.deepEqual((await readOwnLists(api)).map(list => list.id), [
    'new', 'old', 'undated-a', 'undated-b',
  ]);
});

test('readOwnLists drops garbage rows rather than rendering them', async () => {
  const { api } = fakeApi({
    ownLists: async () => [
      { id: 'ok', name: 'Fine', paperIds: ['x'] },
      { id: '', name: 'No id', paperIds: [] },
      { id: 'no-name', name: '', paperIds: [] },
      { id: 'weird', name: 'Weird fields', paperIds: 'not-an-array', publicShareId: 12345 },
    ],
  });
  const lists = await readOwnLists(api);
  assert.deepEqual(lists.map(list => list.id).sort(), ['ok', 'weird']);
  const weird = lists.find(list => list.id === 'weird');
  assert.equal(weird.paperCount, 0);
  assert.equal(weird.isPublished, false, 'a non-string shareId is not a publication');
});

test('readOwnLists refuses demo mode and signed-out callers like the rest of the service', async () => {
  const demo = fakeApi({ isDemo: true, ownLists: async () => [] });
  await assert.rejects(readOwnLists(demo.api), UserProfileUnsupportedError);
  const signedOut = fakeApi({ currentUser: null, ownLists: async () => [] });
  await assert.rejects(readOwnLists(signedOut.api), /Authentication is required/);
});
