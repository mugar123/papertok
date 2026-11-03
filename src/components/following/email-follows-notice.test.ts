import test from 'node:test';
import assert from 'node:assert/strict';
import { emailFollowsNotice } from './email-follows-notice.ts';

const journal = { type: 'journal' as const, canonicalId: 'S23254222', displayName: 'American Economic Review' };
const author = { type: 'author' as const, canonicalId: 'A10', displayName: 'Ana Economist' };

// ENG-123 (D6): the digest leaves journals out. A reader who follows only
// journals follows something, and Settings lists it, so the email settings
// say why there is no digest instead of "Nothing followed yet".
test('the email settings tell a reader who follows only journals that journals are not in the email', () => {
  const notice = emailFollowsNotice([journal], false);
  assert.ok(notice);
  assert.equal(notice.heading, 'Journals are not in the email yet');
  assert.doesNotMatch(notice.body, /nothing/i);
  assert.equal(emailFollowsNotice([journal], true)?.heading, 'Journals are not in the email yet', 'whether or not they asked for the digest when they joined');
});

test('the email settings say nothing is followed only when nothing is', () => {
  assert.equal(emailFollowsNotice([], false)?.heading, 'Nothing followed yet');
  assert.match(emailFollowsNotice([], true)!.body, /when you joined/);
  assert.equal(emailFollowsNotice([author, journal], false), null);
});

// ENG-163: with no digest follow, the reader's chosen categories fill the email.
test('the email settings tell a reader with chosen categories and no digest follow that the email covers their interests', () => {
  assert.equal(emailFollowsNotice([], false, true)?.heading, 'Your email covers your interests');
  assert.equal(emailFollowsNotice([journal], true, true)?.heading, 'Your email covers your interests');
  assert.equal(emailFollowsNotice([author], false, true), null);
});
