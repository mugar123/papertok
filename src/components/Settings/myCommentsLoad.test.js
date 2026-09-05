import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientReadError } from '../../utils/boundedRead.js';
import { UnconfirmedAbsenceError, authoritativePage } from './myCommentsLoad.js';

const EMPTY = { comments: [], cursor: null, hasMore: false };

test('an empty page from the cache is not an answer, and patientRead will retry it', () => {
  assert.throws(() => authoritativePage({ ...EMPTY, fromCache: true }), UnconfirmedAbsenceError);
  try {
    authoritativePage({ ...EMPTY, fromCache: true });
  } catch (error) {
    assert.equal(error.code, 'unavailable');
    assert.equal(isTransientReadError(error), true);
  }
});

test('an empty page the server vouched for is an answer', () => {
  const page = { ...EMPTY, fromCache: false };
  assert.equal(authoritativePage(page), page);
});

test('data in hand is data, cached or not', () => {
  const page = { comments: [{ id: 'c1' }], cursor: null, hasMore: false, fromCache: true };
  assert.equal(authoritativePage(page), page);
});
