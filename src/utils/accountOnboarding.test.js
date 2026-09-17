import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accountLooksOnboarded, USER_PREFERENCES_MAX } from './accountOnboarding.js';

test('the flag is enough, and so are stored preferences without it', () => {
  assert.equal(accountLooksOnboarded({ onboardingComplete: true }), true);
  assert.equal(accountLooksOnboarded({ preferences: ['astro'] }), true);
  assert.equal(accountLooksOnboarded({ selectedCategories: ['hep-th'] }), true);
  assert.equal(accountLooksOnboarded({ onboardingComplete: false, preferences: [] }), false);
  assert.equal(accountLooksOnboarded({}), false);
  assert.equal(accountLooksOnboarded(null), false);
});

test('the client cap is the rules cap, read from the rules file itself', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  assert.equal(USER_PREFERENCES_MAX, 100);
  assert.match(rules, new RegExp(`preferences\\.size\\(\\) <= ${USER_PREFERENCES_MAX}\\)`));
});
