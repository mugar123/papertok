import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DECLARED_DEPLOY_FLAGS,
  describeDeployFlagDrift,
  findDeployFlagDrift,
  isDeployFlagEnabled,
} from './deployFlags.js';

// This is the decision itself, not a detail of it. Scopus was measured against
// OpenAlex (75 of 75 already held) and retired; flipping the declaration should
// take a deliberate edit here, not ride along with an unrelated change.
test('Scopus stays declared off', () => {
  assert.equal(DECLARED_DEPLOY_FLAGS.VITE_SCOPUS_ENABLED, false);
});

test('reads a flag exactly as the app reads it', () => {
  assert.equal(isDeployFlagEnabled('true'), true);
  // Everything else is off, including the near-misses. The app compares against
  // the literal 'true', so a guard that accepted these would disagree with the
  // bundle it is meant to be checking.
  for (const value of ['false', '', ' true', 'TRUE', 'True', '1', 'yes', undefined, null]) {
    assert.equal(isDeployFlagEnabled(value), false, `expected ${JSON.stringify(value)} to read as off`);
  }
});

test('an absent variable is not drift: it is the declared state', () => {
  // The deploy workflow passes `${{ vars.VITE_SCOPUS_ENABLED }}`, and an unset
  // repository variable arrives as an empty string. That is production today.
  assert.deepEqual(findDeployFlagDrift({}), []);
  assert.deepEqual(findDeployFlagDrift({ VITE_SCOPUS_ENABLED: '' }), []);
  assert.deepEqual(findDeployFlagDrift({ VITE_SCOPUS_ENABLED: 'false' }), []);
});

test('reports a build that would ship the opposite of the declaration', () => {
  assert.deepEqual(findDeployFlagDrift({ VITE_SCOPUS_ENABLED: 'true' }), [
    { name: 'VITE_SCOPUS_ENABLED', expected: false, actual: true },
  ]);
});

test('reports drift in the other direction too', () => {
  // Both directions have happened. A flag declared on and shipped off is the
  // same class of failure and has to be caught by the same comparison.
  const declared = { VITE_EXAMPLE_FLAG: true };
  assert.deepEqual(findDeployFlagDrift({}, declared), [
    { name: 'VITE_EXAMPLE_FLAG', expected: true, actual: false },
  ]);
  assert.deepEqual(findDeployFlagDrift({ VITE_EXAMPLE_FLAG: 'true' }, declared), []);
});

test('names the flag and both values so the build error is actionable', () => {
  const message = describeDeployFlagDrift(findDeployFlagDrift({ VITE_SCOPUS_ENABLED: 'true' }));
  assert.match(message, /VITE_SCOPUS_ENABLED/);
  assert.match(message, /declared false/);
  assert.match(message, /would ship true/);
});

// The guard is only as true as this coupling: it decides whether a bundle is
// correct by re-implementing the adapter's coercion. If the adapter ever reads
// the flag differently, the guard would keep passing builds while the bundle
// disagreed with the declaration — the exact failure it exists to prevent.
test('the adapter still reads the flag the way the guard assumes', () => {
  const source = readFileSync(new URL('../services/adapters/ScopusAdapter.js', import.meta.url), 'utf8');
  assert.match(source, /VITE_SCOPUS_ENABLED\s*===\s*'true'/);
});
