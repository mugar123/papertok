import assert from 'node:assert/strict';
import test from 'node:test';
import { revealScrollDelta } from './railReveal.js';

/**
 * How far the annotation list scrolls to show a card: the model's answer as it
 * arrives, and the card that waits for it. Rects are viewport boxes, the way
 * `getBoundingClientRect()` gives them: the list shows 100…700.
 */

const LIST = { top: 100, bottom: 700 };

test('a card already in view is left where it is', () => {
  assert.equal(revealScrollDelta(LIST, { top: 200, bottom: 450 }), 0);
});

test('a card below the fold comes up just far enough to show its bottom', () => {
  assert.equal(revealScrollDelta(LIST, { top: 650, bottom: 800 }), 100);
});

test('a card taller than the list comes up to its top, not past it', () => {
  assert.equal(revealScrollDelta(LIST, { top: 650, bottom: 1400 }), 550);
});

test('a card above the view comes down to show its top', () => {
  assert.equal(revealScrollDelta(LIST, { top: 40, bottom: 140 }), -60);
});
