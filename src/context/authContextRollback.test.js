import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first (convention of ce139ce): the guard is explained
// in a comment right above itself, and a matcher that reads comments would be
// satisfied by the explanation alone.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('optimistic rollbacks only run for the session that started the write', async () => {
  const src = stripComments(await readFile(new URL('./AuthContext.jsx', import.meta.url), 'utf8'));
  const rollbacks = src.match(/catch \(updateError\) \{[^}]*\}/g) || [];
  assert.equal(rollbacks.length, 2);
  const setters = [];
  for (const block of rollbacks) {
    assert.match(block, /auth\.currentUser\?\.uid === userId/);
    // The guard has to gate the setState, not merely sit in the same block.
    const guarded = block.match(/auth\.currentUser\?\.uid === userId\)\s*(set\w+)\(previous\)/);
    assert.ok(guarded, `the rollback is not gated by the uid check: ${block}`);
    setters.push(guarded[1]);
    assert.match(block, /throw updateError/);
  }
  assert.deepEqual(setters.sort(), ['setProfilePhoto', 'setReadingPreferences']);
});
