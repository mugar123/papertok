import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Comments are stripped first: the fix is explained in a comment right above
// the call, and a matcher that reads comments would pass on the explanation
// alone. Convention of ce139ce.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the public photo mirror is pinned to the user who picked the file', async () => {
  const src = stripComments(await readFile(new URL('./SettingsPage.jsx', import.meta.url), 'utf8'));
  const call = src.match(/savePublicProfilePhoto\([^;]{0,300};/);
  assert.ok(call, 'savePublicProfilePhoto call not found');
  assert.match(call[0], /currentUser:\s*user\b/);
});
