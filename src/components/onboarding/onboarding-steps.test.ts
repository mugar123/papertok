import test from 'node:test';
import assert from 'node:assert/strict';
import { onboardingSaveError, onboardingSteps } from './onboarding-steps.ts';
import { confirmOnboardingWrite } from '../../context/profile-load.ts';

test('a reader without a guest answer is asked for topics, then subtopics, then the university', () => {
  assert.deepEqual(onboardingSteps({ asksTopics: true }), ['topics', 'subtopics', 'university']);
});

test('a reader with a guest answer only sees the screen that saves it', () => {
  assert.deepEqual(onboardingSteps({ asksTopics: false }), ['finish']);
});

test('a profile write that timed out asks for a retry on a better connection', async () => {
  const timeout = await confirmOnboardingWrite(new Promise<never>(() => {}), 5).catch((error: unknown) => error);
  assert.deepEqual(onboardingSaveError(timeout), { message: 'Still saving. Check your connection and try again.', unexpected: false });
});

test('any other save failure is the generic message, and logged', () => {
  const refusal = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  assert.deepEqual(onboardingSaveError(refusal), { message: 'Could not save. Try again.', unexpected: true });
  assert.deepEqual(onboardingSaveError(null), { message: 'Could not save. Try again.', unexpected: true });
});
