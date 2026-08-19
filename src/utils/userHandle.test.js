import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  HANDLE_ERRORS,
  HANDLE_MAX_LENGTH,
  InvalidHandleError,
  RESERVED_HANDLES,
  inspectHandle,
  isReservedHandle,
  isValidHandle,
  normalizeHandle,
  requireHandle,
} from './userHandle.js';

test('folds case, whitespace and a leading @ into one canonical handle', () => {
  assert.equal(normalizeHandle('  @Ada_Lovelace  '), 'ada_lovelace');
  assert.equal(normalizeHandle('ADA'), 'ada');
  assert.equal(normalizeHandle('@@ada'), 'ada');
  assert.equal(normalizeHandle(null), '');
});

test('two spellings of the same handle collapse to the same reservation', () => {
  // If these ever diverge, `handles/{handle}` stops being unique in practice:
  // @Ada and @ada would reserve two different documents.
  assert.equal(normalizeHandle('Ada'), normalizeHandle('ada'));
  assert.equal(normalizeHandle('aDa'), normalizeHandle('ADA'));
});

test('accepts the documented character set only', () => {
  assert.ok(isValidHandle('ada'));
  assert.ok(isValidHandle('ada_lovelace_1815'));
  assert.ok(isValidHandle('a1_'));

  for (const rejected of [
    'ada lovelace', 'ada-lovelace', 'ada.lovelace', 'ada@x', 'adá',
    'Ada/Lovelace', 'ada#1', 'ada!', 'ada\nlovelace', '../admin', 'ada%20',
  ]) {
    assert.equal(isValidHandle(rejected), false, `${rejected} should be rejected`);
  }
});

test('rejects a handle with no letter in it', () => {
  // All-digit or all-underscore handles read as internal ids.
  assert.equal(inspectHandle('123').code, HANDLE_ERRORS.numericOnly);
  assert.equal(inspectHandle('___').code, HANDLE_ERRORS.numericOnly);
});

test('enforces the length bounds', () => {
  assert.equal(inspectHandle('ab').code, HANDLE_ERRORS.tooShort);
  assert.ok(isValidHandle('abc'));
  assert.ok(isValidHandle('a'.repeat(HANDLE_MAX_LENGTH)));
  assert.equal(inspectHandle('a'.repeat(HANDLE_MAX_LENGTH + 1)).code, HANDLE_ERRORS.tooLong);
  assert.equal(inspectHandle('').code, HANDLE_ERRORS.empty);
});

test('refuses reserved handles, however they are spelled', () => {
  for (const reserved of ['admin', 'api', 'settings', 'login', 'public', 'papertok']) {
    assert.equal(isValidHandle(reserved), false, `${reserved} must stay reserved`);
    assert.equal(inspectHandle(reserved).code, HANDLE_ERRORS.reserved);
    assert.ok(isReservedHandle(` @${reserved.toUpperCase()} `));
  }
});

test('every application route segment is reserved', () => {
  // A handle equal to a route segment would make /public/user/<handle>
  // ambiguous with the app's own pages.
  for (const route of [
    'lists', 'research', 'following', 'settings', 'search', 'login',
    'onboarding', 'explorer', 'public', 'report', 'paper', 'entity', 'user',
  ]) {
    assert.ok(isReservedHandle(route), `${route} is a route and must be reserved`);
  }
});

test('requireHandle returns the canonical form or throws with a code', () => {
  assert.equal(requireHandle(' @Ada '), 'ada');
  assert.throws(() => requireHandle('admin'), (error) => (
    error instanceof InvalidHandleError && error.code === HANDLE_ERRORS.reserved
  ));
  assert.throws(() => requireHandle('a b'), InvalidHandleError);
});

test('RULES: the reserved list in firestore.rules matches this module exactly', async () => {
  // The client copy is a courtesy; the rules copy is what is enforced. Drift
  // between them means a handle this module refuses is still claimable.
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const block = rules.match(/function reservedHandles\(\) \{\s*return \[([\s\S]*?)\];/)?.[1];
  assert.ok(block, 'firestore.rules must declare reservedHandles()');
  const inRules = block.match(/'([a-z0-9_]+)'/g).map(value => value.slice(1, -1));
  assert.deepEqual([...inRules].sort(), [...RESERVED_HANDLES].sort());
});

test('RULES: the handle grammar in firestore.rules matches this module', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /handle\.matches\('\^\[a-z0-9_\]\{3,40\}\$'\)/);
  assert.match(rules, /handle\.matches\('\^\[a-z0-9_\]\*\[a-z\]\[a-z0-9_\]\*\$'\)/);
  assert.match(rules, /!\(handle in reservedHandles\(\)\)/);
});
