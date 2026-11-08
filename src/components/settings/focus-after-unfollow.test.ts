import test from 'node:test';
import assert from 'node:assert/strict';
import { focusAfterUnfollow } from './focus-after-unfollow.ts';

const ROWS = ['journal:S1', 'journal:S2', 'journal:S3'];

// ENG-170: focus returned to the unfollowed row's own button, which its exit
// animation then removed, and focus fell to the page.
test('an unfollowed row hands focus to the next row', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S1'), 'journal:S2');
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S2'), 'journal:S3');
});

test('the last row hands focus to the one before it', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S3'), 'journal:S2');
});

test('no row takes focus when the list empties or the row is not in it', () => {
  assert.equal(focusAfterUnfollow(['author:A1'], 'author:A1'), null);
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S9'), null);
  assert.equal(focusAfterUnfollow([], 'journal:S1'), null);
});
