import test from 'node:test';
import assert from 'node:assert/strict';
import { TAB_ORDER, lateralTabDirection } from './tabDirection.js';

/** Every test brings its own memory, the way `routeDirection.test.js` does. */
const fresh = () => ({});

test('the bar order is the order the navbar renders', () => {
  assert.deepEqual(TAB_ORDER, ['/', '/research', '/following']);
});

test('the first tab seen has nothing to compare against', () => {
  // The app booting straight into the feed is an arrival, not a slide: the
  // caller keeps its history direction, which is 0 on the first entry, and the
  // feed's cards compose instead of sitting at rest.
  assert.equal(lateralTabDirection('/', fresh()), null);
});

test('moving right along the bar goes one way and moving left goes the other', () => {
  const memory = fresh();
  assert.equal(lateralTabDirection('/', memory), null);
  assert.equal(lateralTabDirection('/following', memory), 1);
  assert.equal(lateralTabDirection('/', memory), -1);
});

test('the sign is the distance along the bar, not the number of tabs crossed', () => {
  const memory = fresh();
  lateralTabDirection('/', memory);
  // Two tabs to the right is still 1: the page travels a fixed 18px whatever
  // the distance, so only the side matters.
  assert.equal(lateralTabDirection('/following', memory), 1);
  assert.equal(lateralTabDirection('/research', memory), -1);
  assert.equal(lateralTabDirection('/following', memory), 1);
});

test('the same tab twice repeats the answer instead of cancelling it', () => {
  // One navigation renders PageTransition several times — the leaving page
  // re-renders inside AnimatePresence while the arriving one mounts. Without
  // this latch the second render would report `null` and the page would change
  // direction halfway through its own animation.
  const memory = fresh();
  lateralTabDirection('/', memory);
  assert.equal(lateralTabDirection('/following', memory), 1);
  assert.equal(lateralTabDirection('/following', memory), 1);
  assert.equal(lateralTabDirection('/following', memory), 1);
});

test('a route outside the bar clears the memory, so returning is a return', () => {
  const memory = fresh();
  lateralTabDirection('/', memory);
  assert.equal(lateralTabDirection('/explorer/author/A5006398227', memory), null);
  // Not 1: we did not step along the bar from For you to Following, we came
  // back out of an entity. That is history's answer to give, not ours.
  assert.equal(lateralTabDirection('/following', memory), null);
});

test('a trailing slash is the same tab', () => {
  const memory = fresh();
  lateralTabDirection('/', memory);
  assert.equal(lateralTabDirection('/following/', memory), 1);
  assert.equal(lateralTabDirection('/following', memory), 1);
});

test('a missing or empty pathname is not a tab', () => {
  assert.equal(lateralTabDirection(undefined, fresh()), null);
  assert.equal(lateralTabDirection(null, fresh()), null);
  assert.equal(lateralTabDirection('', fresh()), null);
});

test('the memory is per-caller, so one page cannot read another page position', () => {
  const a = fresh();
  const b = fresh();
  lateralTabDirection('/', a);
  assert.equal(lateralTabDirection('/following', a), 1);
  // `b` never saw the feed, so Following is its first tab and has no direction.
  assert.equal(lateralTabDirection('/following', b), null);
});
