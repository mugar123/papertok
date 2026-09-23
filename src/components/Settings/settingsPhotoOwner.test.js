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

test('the public photo mirror is bounded and a copy that did not land is not reported as done', async () => {
  // Reported 2026-09-23: the mirror awaited a read on a dead listen stream and
  // the spinner never stopped. The service now reads patiently, but the screen
  // still owns the spinner, so it owns the ceiling too.
  const src = stripComments(await readFile(new URL('./SettingsPage.jsx', import.meta.url), 'utf8'));
  const helper = src.match(/const mirrorPublicPhoto = async \(makePhoto\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(helper, 'mirrorPublicPhoto is gone or reshaped');
  assert.match(helper[0], /settleWithin\(\s*Promise\.resolve\(\)[\s\S]*savePublicProfilePhoto\([\s\S]*PUBLIC_PHOTO_MIRROR_TIMEOUT_MS,?\s*\)/);
  assert.match(helper[0], /if \(settled\.status === 'fulfilled'\) return true;/);
  assert.equal(
    (src.match(/savePublicProfilePhoto\(/g) || []).length,
    1,
    'every mirror goes through the bounded helper',
  );
  const outcomes = src.match(/const mirrored = await mirrorPublicPhoto\([\s\S]*?\);\s*setPhotoFeedback\(mirrored\s*\?[\s\S]*?:\s*\{ tone: 'error', text: copy\.photoPublicPending \}\);/g) || [];
  assert.equal(outcomes.length, 2, 'both the upload and the restore say when the public copy is behind');
});
