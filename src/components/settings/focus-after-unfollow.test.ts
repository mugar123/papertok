import test from 'node:test';
import assert from 'node:assert/strict';
import { focusAfterUnfollow, focusLeftByQuestion } from './focus-after-unfollow.ts';

const ROWS = ['journal:S1', 'journal:S2', 'journal:S3'];
const NONE = new Set<string>();

// ENG-170: focus returned to the unfollowed row's own button, which its exit
// animation then removed, and focus fell to the page.
test('an unfollowed row hands focus to the next row', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S1', NONE), 'journal:S2');
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S2', NONE), 'journal:S3');
});

test('the last row hands focus to the one before it', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S3', NONE), 'journal:S2');
});

test('no row takes focus when the list empties or the row is not in it', () => {
  assert.equal(focusAfterUnfollow(['author:A1'], 'author:A1', NONE), null);
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S9', NONE), null);
  assert.equal(focusAfterUnfollow([], 'journal:S1', NONE), null);
});

// A row brought back by Undo stays disabled while its follow is written, and
// a disabled button does not take focus.
test('a pending row after it is passed over for the next enabled row', () => {
  const rows = ['journal:S1', 'journal:S2', 'journal:S3', 'journal:S4'];
  assert.equal(focusAfterUnfollow(rows, 'journal:S1', new Set(['journal:S2'])), 'journal:S3');
});

test('with no enabled row after it, the nearest enabled row before takes focus', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S2', new Set(['journal:S3'])), 'journal:S1');
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S3', new Set(['journal:S2'])), 'journal:S1');
});

test('no row takes focus when every other row is pending', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S1', new Set(['journal:S2', 'journal:S3'])), null);
});

test('the removed row is found even if it is pending itself', () => {
  assert.equal(focusAfterUnfollow(ROWS, 'journal:S2', new Set(['journal:S2'])), 'journal:S3');
});

// A stand-in for DOM nodes: each contains itself and the nodes listed under it.
interface Spot { name: string; contains(other: Spot | null): boolean }
function spot(name: string, inside: Spot[] = []): Spot {
  const node: Spot = { name, contains: other => other === node || inside.some(child => child.contains(other)) };
  return node;
}
const body = spot('body');
const rowButton = spot('Unfollow Barbara Sample');
const questionButton = spot('Unfollow');
const question = spot('question', [questionButton]);

test('an unfollow hands focus on while nothing, the question or its row holds it', () => {
  assert.equal(focusLeftByQuestion(null, { body, rowButton, question: null }), true);
  assert.equal(focusLeftByQuestion(body, { body, rowButton, question: null }), true);
  assert.equal(focusLeftByQuestion(rowButton, { body, rowButton, question }), true);
  assert.equal(focusLeftByQuestion(questionButton, { body, rowButton, question }), true);
  assert.equal(focusLeftByQuestion(question, { body, rowButton, question }), true);
});

// ENG-170 review: opening search while the question closed sent focus from
// the search field to the row behind the palette.
test('focus the reader moved during the close stays where it is', () => {
  const searchField = spot('Search');
  assert.equal(focusLeftByQuestion(searchField, { body, rowButton, question }), false);
  assert.equal(focusLeftByQuestion(searchField, { body, rowButton, question: null }), false);
  assert.equal(focusLeftByQuestion(spot('Unfollow Ada Example'), { body, rowButton: undefined, question: null }), false);
});
