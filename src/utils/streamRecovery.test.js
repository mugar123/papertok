import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamRecovery, MIN_STREAM_RECOVERY_INTERVAL_MS } from './streamRecovery.js';

/** Records the order the SDK's two calls arrive in, and can make either fail. */
function fakeSdk() {
  const calls = [];
  return {
    calls,
    disable: async () => { calls.push('disable'); },
    enable: async () => { calls.push('enable'); },
  };
}

test('a recovery closes the stream and opens it again, in that order', async () => {
  const sdk = fakeSdk();
  const recover = createStreamRecovery({ disable: sdk.disable, enable: sdk.enable, now: () => 1000, isOffline: () => false });
  assert.equal(await recover(), true);
  assert.deepEqual(sdk.calls, ['disable', 'enable']);
});

test('stalled reads arrive together; they get one kick, not one each', async () => {
  const sdk = fakeSdk();
  let clock = 1000;
  const recover = createStreamRecovery({ disable: sdk.disable, enable: sdk.enable, now: () => clock, isOffline: () => false });
  await recover();
  clock += 500;
  assert.equal(await recover(), false, 'inside the interval: the stream was just rebuilt');
  assert.deepEqual(sdk.calls, ['disable', 'enable']);
  clock += MIN_STREAM_RECOVERY_INTERVAL_MS;
  assert.equal(await recover(), true, 'a stall that survives the interval is a new stall');
  assert.deepEqual(sdk.calls, ['disable', 'enable', 'disable', 'enable']);
});

test('with no network there is nothing to rebuild, and the interval is not spent', async () => {
  const sdk = fakeSdk();
  let offline = true;
  const recover = createStreamRecovery({ disable: sdk.disable, enable: sdk.enable, now: () => 1000, isOffline: () => offline });
  assert.equal(await recover(), false);
  assert.deepEqual(sdk.calls, []);
  offline = false;
  assert.equal(await recover(), true, 'the next stall with a network gets its kick at once');
});

test('the SDK refusing the toggle is logged, never thrown into a screen', async () => {
  const warnings = [];
  const recover = createStreamRecovery({
    disable: async () => { throw new Error('terminated'); },
    enable: async () => {},
    now: () => 1000,
    isOffline: () => false,
    warn: (...args) => warnings.push(args.join(' ')),
  });
  assert.equal(await recover(), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /terminated/);
});

test('the interval is long enough that a kick cannot chase its own retries', () => {
  // The retry after a flushed hostage waits 800 ms and a healthy read answers
  // under half a second; a second kick inside that window would flush the
  // very read that was about to answer.
  assert.ok(MIN_STREAM_RECOVERY_INTERVAL_MS >= 5000);
});
