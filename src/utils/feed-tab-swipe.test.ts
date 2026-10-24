import test from 'node:test';
import assert from 'node:assert/strict';
import { tabSwipeTarget } from './feed-tab-swipe.ts';

const swipe = (from: string, dx: number, dy = 0, startX = 200) => tabSwipeTarget({ from, startX, dx, dy, viewportWidth: 400 });

test('a swipe left on For you opens Following, and a swipe right comes back', () => {
  assert.equal(swipe('/feed', -80), '/following');
  assert.equal(swipe('/following', 80), '/feed');
});

test('there is no tab beyond either end', () => {
  assert.equal(swipe('/feed', 80), null);
  assert.equal(swipe('/following', -80), null);
});

test('short, diagonal and edge swipes, and other surfaces, stay put', () => {
  assert.equal(swipe('/feed', -40), null);
  assert.equal(swipe('/feed', -80, 50), null);
  assert.equal(swipe('/following', 80, 0, 10), null);
  assert.equal(swipe('/search', -80), null);
});

test('a swipe from the right edge belongs to the browser too', () => {
  assert.equal(swipe('/feed', -80, 0, 390), null);
});
