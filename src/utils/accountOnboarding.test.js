import test from 'node:test';
import assert from 'node:assert/strict';
import { accountLooksOnboarded } from './accountOnboarding.js';

test('the flag is enough, and so are stored preferences without it', () => {
  assert.equal(accountLooksOnboarded({ onboardingComplete: true }), true);
  assert.equal(accountLooksOnboarded({ preferences: ['astro'] }), true);
  assert.equal(accountLooksOnboarded({ selectedCategories: ['hep-th'] }), true);
  assert.equal(accountLooksOnboarded({ onboardingComplete: false, preferences: [] }), false);
  assert.equal(accountLooksOnboarded({}), false);
  assert.equal(accountLooksOnboarded(null), false);
});
