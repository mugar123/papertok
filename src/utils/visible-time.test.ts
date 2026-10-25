import test from 'node:test';
import assert from 'node:assert/strict';
import { trackVisibleTime } from './visible-time.ts';

function view(hidden = false) {
  const visibility = Object.assign(new EventTarget(), { hidden });
  let time = 0;
  const reported: number[] = [];
  const tracker = trackVisibleTime(visibility, seconds => reported.push(seconds), () => time);
  return {
    tracker, reported,
    advance(milliseconds: number) { time += milliseconds; },
    hide(value: boolean) {
      visibility.hidden = value;
      visibility.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

test('a minute in a hidden tab adds no reading time', () => {
  const v = view();
  v.tracker.setInView(true);
  v.advance(2000);
  v.hide(true);
  v.advance(60_000);
  v.hide(false);
  v.advance(3000);
  v.tracker.setInView(false);
  assert.deepEqual(v.reported, [5]);
  v.tracker.stop();
  assert.deepEqual(v.reported, [5]);
});

test('a card first seen in a hidden tab starts timing only in the foreground', () => {
  const v = view(true);
  v.tracker.setInView(true);
  v.advance(30_000);
  v.hide(false);
  v.advance(1250);
  v.tracker.stop();
  assert.deepEqual(v.reported, [1.25]);
});

test('leaving the viewport while hidden flushes once and does not resume off screen', () => {
  const v = view();
  v.tracker.setInView(true);
  v.advance(2000);
  v.hide(true);
  v.advance(20_000);
  v.tracker.setInView(false);
  v.hide(false);
  v.advance(5000);
  v.tracker.stop();
  assert.deepEqual(v.reported, [2]);
});

test('returning to a card starts a separate interval and repeated observations do not reset it', () => {
  const v = view();
  v.tracker.setInView(true);
  v.advance(1000);
  v.tracker.setInView(true);
  v.advance(1000);
  v.tracker.setInView(false);
  v.advance(10_000);
  v.tracker.setInView(true);
  v.advance(3000);
  v.tracker.stop();
  v.hide(true);
  v.advance(10_000);
  v.hide(false);
  v.tracker.stop();
  assert.deepEqual(v.reported, [2, 3]);
});
