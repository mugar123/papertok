import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWithin, settleWithin } from './asyncTiming.js';

test('returns a fast result without waiting for the full budget', async () => {
  assert.deepEqual(await settleWithin(Promise.resolve(['paper']), 50), {
    status: 'fulfilled',
    value: ['paper'],
  });
});

test('falls back when a source exceeds its rendering budget', async () => {
  const result = await settleWithin(new Promise(() => {}), 5);
  assert.equal(result.status, 'timed_out');
  assert.deepEqual(await resolveWithin(new Promise(() => {}), 5, []), []);
});

test('contains a rejected optional source', async () => {
  const error = new Error('unavailable');
  const result = await settleWithin(Promise.reject(error), 50);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, error);
});
