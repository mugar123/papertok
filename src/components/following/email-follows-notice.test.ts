import test from 'node:test';
import assert from 'node:assert/strict';
import { emailFollowsNotice } from './email-follows-notice.ts';
import { digestOptInWaitsForFollow } from '../../utils/digest-shutoff.ts';

test('the email settings explain citation updates when an ORCID reader follows nothing', () => {
  assert.match(emailFollowsNotice([], false, false, true)!.body, /papers that cite your work/);
});

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
  assert.equal(emailFollowsNotice([journal], false, true)?.heading, 'Your email covers your interests');
  assert.equal(emailFollowsNotice([author], false, true), null);
});

// The welcome promised a yes starts with the first follow, so a pending yes
// is still told that, chosen categories or not.
test('the email settings tell a reader who asked for the digest when they joined that it starts with the first follow', () => {
  assert.match(emailFollowsNotice([], true, true)!.body, /starts on its own with your first follow/);
  assert.equal(emailFollowsNotice([journal], true, true)?.heading, 'Journals are not in the email yet');
});

// Settings reads the same rule the subscription does: a yes from an account
// created after the email began from sign-up is on its chosen topics at once.
test('the email settings show a new account\'s yes as covering its interests, and an older account\'s as waiting', () => {
  const effectiveAt = '2026-11-25T00:00:00Z';
  const newYes = digestOptInWaitsForFollow({ pending: true, accountCreated: '2026-11-25T09:30:00Z', effectiveAt });
  const oldYes = digestOptInWaitsForFollow({ pending: true, accountCreated: '2026-11-24T12:00:00Z', effectiveAt });
  assert.equal(emailFollowsNotice([], newYes, true)?.heading, 'Your email covers your interests');
  assert.match(emailFollowsNotice([], oldYes, true)!.body, /starts on its own with your first follow/);
});
