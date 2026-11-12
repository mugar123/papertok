import test from 'node:test';
import assert from 'node:assert/strict';
import { allFeedTabs } from './feed-tabs.ts';
import { feedTabPathForSurface, tabSwipeTarget } from './feed-tab-swipe.ts';

const swipe = (from: string, dx: number, dy = 0, startX = 200) => tabSwipeTarget({ from, paths: ['/feed', '/following'], startX, dx, dy, viewportWidth: 400 });

test('a swipe left on For you opens Following, and a swipe right comes back', () => {
  assert.equal(swipe('/feed', -80), '/following');
  assert.equal(swipe('/following', 80), '/feed');
});

test('the fixed tabs swipe through Most recent in both directions', () => {
  const swipe = (from: string, dx: number) => tabSwipeTarget({ from, paths: allFeedTabs([]).map(tab => tab.path), startX: 200, dx, dy: 0, viewportWidth: 400 });
  assert.equal(swipe('/feed', -80), '/recent');
  assert.equal(swipe('/recent', -80), '/following');
  assert.equal(swipe('/following', 80), '/recent');
  assert.equal(swipe('/recent', 80), '/feed');
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

test('a swipe moves along every tab of the bar, the reader\'s feeds included', () => {
  const paths = ['/feed', '/following', '/feeds/abcd1234'];
  const swipe = (from: string, dx: number) => tabSwipeTarget({ from, paths, startX: 200, dx, dy: 0, viewportWidth: 390 });
  assert.equal(swipe('/following', -80), '/feeds/abcd1234');
  assert.equal(swipe('/feeds/abcd1234', 80), '/following');
  assert.equal(swipe('/feeds/abcd1234', -80), null);
});

test('For you, which passes no surface key, is a tab; Following is too; a Similar layer is not', () => {
  assert.equal(feedTabPathForSurface(undefined), '/feed');
  assert.equal(feedTabPathForSurface('following'), '/following');
  assert.equal(feedTabPathForSurface('recent'), '/recent');
  assert.equal(feedTabPathForSurface('similar:W123'), undefined);
});
