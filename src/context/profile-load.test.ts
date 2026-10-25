import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmOnboardingWrite, profileReadOutcome } from './profile-load.ts';

const snapshot = { id: 'account-a' };

test('a profile read that fails with nothing from the cache is PROFILE_LOAD_FAILED', () => {
  // Whatever this device remembers about the onboarding: it is no input.
  assert.deepEqual(profileReadOutcome({ status: 'timed_out' }, false), { kind: 'failed', code: 'PROFILE_LOAD_FAILED' });
  assert.deepEqual(profileReadOutcome({ status: 'rejected', reason: new Error('unavailable') }, false), { kind: 'failed', code: 'PROFILE_LOAD_FAILED' });
});

test('a profile read that fails after the cache painted the profile keeps that paint', () => {
  assert.deepEqual(profileReadOutcome({ status: 'timed_out' }, true), { kind: 'keep-cached' });
  assert.deepEqual(profileReadOutcome({ status: 'rejected', reason: new Error('unavailable') }, true), { kind: 'keep-cached' });
});

test('the server\'s answer is applied, over the cache too', () => {
  assert.deepEqual(profileReadOutcome({ status: 'fulfilled', value: snapshot }, false), { kind: 'apply', snapshot });
  assert.deepEqual(profileReadOutcome({ status: 'fulfilled', value: snapshot }, true), { kind: 'apply', snapshot });
});

test('the onboarding write resolves only once it is fulfilled', async () => {
  const steps: string[] = [];
  let land!: () => void;
  const write = new Promise<void>(resolve => { land = resolve; });
  const confirmed = confirmOnboardingWrite(write, 1_000).then(() => { steps.push('confirmed'); });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(steps, [], 'nothing runs while the write is in flight');
  land();
  await confirmed;
  assert.deepEqual(steps, ['confirmed']);
});

test('an onboarding write that does not settle in time throws ONBOARDING_WRITE_TIMEOUT', async () => {
  await assert.rejects(
    confirmOnboardingWrite(new Promise<never>(() => {}), 5),
    (error: Error & { code?: string }) => error.code === 'ONBOARDING_WRITE_TIMEOUT',
  );
});

test('a refused onboarding write is rethrown as itself', async () => {
  const refusal = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  await assert.rejects(confirmOnboardingWrite(Promise.reject(refusal), 1_000), error => error === refusal);
});
