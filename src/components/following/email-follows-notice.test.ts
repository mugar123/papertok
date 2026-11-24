import test from 'node:test';
import assert from 'node:assert/strict';
import { emailFollowsNotice } from './email-follows-notice.ts';

test('the email settings explain citation updates when an ORCID reader follows nothing', () => {
  assert.match(emailFollowsNotice([], false, false, true)!.body, /papers that cite your work/);
});

const author = { type: 'author' as const, canonicalId: 'A10', displayName: 'Ana Economist' };

test('the email settings say nothing is followed only when nothing is', () => {
  assert.equal(emailFollowsNotice([], false)?.heading, 'Nothing followed yet');
  assert.match(emailFollowsNotice([], true)!.body, /when you joined/);
  assert.equal(emailFollowsNotice([author], false), null);
});

// ENG-163: with no digest follow, the reader's chosen categories fill the email.
test('the email settings tell a reader with chosen categories and no digest follow that the email covers their interests', () => {
  assert.equal(emailFollowsNotice([], false, true)?.heading, 'Your email covers your interests');
  assert.equal(emailFollowsNotice([author], false, true), null);
});

// The welcome promised a yes starts with the first follow, so a pending yes
// is still told that, chosen categories or not.
test('the email settings tell a reader who asked for the digest when they joined that it starts with the first follow', () => {
  assert.match(emailFollowsNotice([], true, true)!.body, /starts on its own with your first follow/);
});
