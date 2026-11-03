import test from 'node:test';
import assert from 'node:assert/strict';
import { journalLimitNote } from './journal-limit-note.ts';

// D3 (Pablo, 2026-10-25): ten journals at most. An eleventh stored from a
// second device was listed in Settings while the feeds left it out, with
// nothing on screen to say so.
test('the Journals tab says when more journals are followed than the feeds read', () => {
  assert.equal(journalLimitNote(11), 'You follow 11 journals, and only 10 add papers to your feeds. Unfollow one so that all of them do.');
  assert.equal(journalLimitNote(13), 'You follow 13 journals, and only 10 add papers to your feeds. Unfollow 3 so that all of them do.');
});

test('the Journals tab says nothing of the limit up to ten journals', () => {
  assert.equal(journalLimitNote(10), null);
  assert.equal(journalLimitNote(0), null);
});
