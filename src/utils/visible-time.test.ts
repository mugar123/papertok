import test from 'node:test';
import assert from 'node:assert/strict';
import { setCardsCovered, trackVisibleTime } from './visible-time.ts';

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

test('time under the privacy dialog adds no reading time, and the stretch goes on once it closes', (t) => {
  t.after(() => setCardsCovered(false));
  const v = view();
  v.tracker.setInView(true);
  v.advance(2000);
  setCardsCovered(true);
  v.advance(30_000);
  assert.deepEqual(v.reported, [], 'the dialog does not end the stretch');
  setCardsCovered(false);
  v.advance(1000);
  v.tracker.setInView(false);
  assert.deepEqual(v.reported, [3]);
});

test('every card under the dialog waits for it to close, also one that comes into view under it', (t) => {
  t.after(() => setCardsCovered(false));
  const onScreen = view();
  onScreen.tracker.setInView(true);
  setCardsCovered(true);
  const arriving = view();
  arriving.tracker.setInView(true);
  for (const v of [onScreen, arriving]) {
    v.advance(10_000);
    v.hide(true);
    v.hide(false);
    v.advance(5000);
  }
  setCardsCovered(false);
  onScreen.advance(2500);
  arriving.advance(1500);
  onScreen.tracker.stop();
  arriving.tracker.stop();
  assert.deepEqual(onScreen.reported, [2.5]);
  assert.deepEqual(arriving.reported, [1.5]);
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
