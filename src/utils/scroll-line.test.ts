import test from 'node:test';
import assert from 'node:assert/strict';
import { fadingEdges, lineScrollEvent, pressedStillLine, revealScrollLeft } from './scroll-line.ts';

test('a press on a line that has not scrolled is a tap', () => {
  assert.equal(pressedStillLine({ pressedAt: 5000, lastScrollAt: -Infinity, scrollLeftAtPress: 0, scrollLeftAtLift: 0 }), true);
  assert.equal(pressedStillLine({ pressedAt: 5000, lastScrollAt: 4000, scrollLeftAtPress: 120, scrollLeftAtLift: 120 }), true, 'scrolled a second ago, settled since');
});

test('a press that stops a gliding line is not a tap', () => {
  // The fling's last scroll event came 16 ms before the finger landed.
  assert.equal(pressedStillLine({ pressedAt: 5000, lastScrollAt: 4984, scrollLeftAtPress: 300, scrollLeftAtLift: 300 }), false);
});

test('a press during which the line moves is not a tap', () => {
  assert.equal(pressedStillLine({ pressedAt: 5000, lastScrollAt: 5040, scrollLeftAtPress: 300, scrollLeftAtLift: 300 }), false, 'a scroll event after the press');
  assert.equal(pressedStillLine({ pressedAt: 5000, lastScrollAt: 4000, scrollLeftAtPress: 300, scrollLeftAtLift: 260 }), false, 'the position changed');
});

test('a line that fits fades neither edge', () => {
  assert.deepEqual(fadingEdges(0, 300, 300), { start: false, end: false });
});

test('a line fades the edges that have more beyond them', () => {
  assert.deepEqual(fadingEdges(0, 600, 300), { start: false, end: true });
  assert.deepEqual(fadingEdges(150, 600, 300), { start: true, end: true });
  assert.deepEqual(fadingEdges(300, 600, 300), { start: true, end: false });
});

test('a fractional scroll position at the end does not keep a fade', () => {
  assert.deepEqual(fadingEdges(299.6, 600, 300), { start: true, end: false });
  assert.deepEqual(fadingEdges(0.4, 600, 300), { start: false, end: true });
});

test('an item already in view keeps the scroll position', () => {
  assert.equal(revealScrollLeft(150, 60, 100, 300, 24), 100);
});

test('an item past the end is brought in with the padding clear after it', () => {
  // Item spans 400–460; with 24px clear the view must end at 484.
  assert.equal(revealScrollLeft(400, 60, 0, 300, 24), 184);
});

test('an item before the start is brought in with the padding clear before it', () => {
  assert.equal(revealScrollLeft(100, 60, 200, 300, 24), 76);
  assert.equal(revealScrollLeft(10, 60, 200, 300, 24), 0, 'never before the line starts');
});

test('an item wider than the view aligns its start', () => {
  assert.equal(revealScrollLeft(500, 400, 0, 300, 24), 476);
});

test('the line’s own reveal does not count as moving, until it reaches its target', () => {
  // The reveal heads for 184; its events on the way are its own.
  assert.deepEqual(lineScrollEvent(184, 60), { moved: false, revealTo: 184 });
  assert.deepEqual(lineScrollEvent(184, 183.6), { moved: false, revealTo: null }, 'the last event of the reveal');
});

test('with no reveal under way every scroll event counts', () => {
  assert.deepEqual(lineScrollEvent(null, 184), { moved: true, revealTo: null });
});
