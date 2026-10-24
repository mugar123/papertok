import test from 'node:test';
import assert from 'node:assert/strict';
import { interestsSaveRefusal } from './interests-save-refusal.ts';

test('the interests editor saves up to 100 interests and refuses the 101st before the write', () => {
  assert.equal(interestsSaveRefusal(1), null);
  assert.equal(interestsSaveRefusal(100), null);
  assert.equal(interestsSaveRefusal(101), 'At most 100 interests: drop 1.');
  assert.equal(interestsSaveRefusal(130), 'At most 100 interests: drop 30.');
});

test('the interests editor refuses to save no interests at all', () => {
  assert.equal(interestsSaveRefusal(0), 'Select at least one research area.');
});
