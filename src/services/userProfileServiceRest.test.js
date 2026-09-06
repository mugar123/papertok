import test from 'node:test';
import assert from 'node:assert/strict';
import { FirestoreRestError } from '../utils/firestoreRest.js';
import { UserProfileUnsupportedError, readUserProfileOverRest } from './userProfileService.js';

/**
 * The profile read the follow sheet uses for each row: one request, the same
 * shape `readUserProfile` gives, and a denial that stays a denial — the sheet
 * decides what a row it may not read looks like, not this function.
 */

function fakeRest(answer) {
  const calls = [];
  return {
    calls,
    rest: {
      async getDocument(path, options = {}) {
        calls.push({ path, signal: options.signal ?? null });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

function restApi(rest) {
  return { currentUser: null, isDemo: false, rest };
}

test('reads one profile by uid over REST, shaped exactly like the SDK read', async () => {
  const { calls, rest } = fakeRest({
    exists: true,
    id: 'u2',
    data: { handle: 'mugar', displayName: 'Mugar', photo: 'https://cdn.example/a.png', visibility: 'public' },
  });
  const controller = new AbortController();

  const profile = await readUserProfileOverRest('u2', { signal: controller.signal }, restApi(rest));

  assert.deepEqual(calls, [{ path: 'userProfiles/u2', signal: controller.signal }]);
  assert.deepEqual(profile, {
    uid: 'u2',
    handle: 'mugar',
    displayName: 'Mugar',
    photo: 'https://cdn.example/a.png',
    visibility: 'public',
    pinnedLists: [],
    pinnedShareIds: [],
  });
});

test('an absence the server confirmed is null', async () => {
  const { rest } = fakeRest({ exists: false, id: 'u3', data: null });
  assert.equal(await readUserProfileOverRest('u3', {}, restApi(rest)), null);
});

test('a denial is not an absence: it surfaces as the error it is', async () => {
  const { rest } = fakeRest(new FirestoreRestError('Missing or insufficient permissions.', { code: 'permission-denied', status: 403 }));
  await assert.rejects(() => readUserProfileOverRest('u4', {}, restApi(rest)), (error) => {
    assert.equal(error.code, 'permission-denied');
    return true;
  });
});

test('an unreadable uid costs no request', async () => {
  const { calls, rest } = fakeRest({ exists: true, id: 'x', data: {} });
  assert.equal(await readUserProfileOverRest('', {}, restApi(rest)), null);
  assert.equal(await readUserProfileOverRest(null, {}, restApi(rest)), null);
  assert.equal(calls.length, 0);
});

test('refuses demo mode like every other profile read', async () => {
  const { rest } = fakeRest({ exists: true, id: 'u2', data: {} });
  await assert.rejects(
    () => readUserProfileOverRest('u2', {}, { ...restApi(rest), isDemo: true }),
    UserProfileUnsupportedError,
  );
});
