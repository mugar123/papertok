import test from 'node:test';
import assert from 'node:assert/strict';

import { HOME_PLACEMENT, choosePlacement, createNudgePlacer, type FocusState, type Placement, type ScreenBox } from './nudge-placement.ts';

// A 320 x 568 screen. Under the navbar the top edge starts at 64 px; the bottom edge ends at 556 px.
const across = (top: number, bottom: number): ScreenBox => ({ left: 12, right: 308, top, bottom });
const control = (top: number, bottom: number): ScreenBox => ({ left: 20, right: 300, top, bottom });

// The panel at normal text size: 111 px tall, and its compact form: 52 px tall.
const SMALL = {
  full: { bottom: across(445, 556), top: across(64, 175) },
  compact: { bottom: across(504, 556), top: across(64, 116) },
};

// With text at 200% the notice is about 433 px tall: 124-556 at the bottom, 64-497 at the top. Its compact
// form is taller there too, as its title wraps: 84 px.
const TALL = {
  full: { bottom: across(124, 556), top: across(64, 497) },
  compact: { bottom: across(472, 556), top: across(64, 148) },
};

test('the panel stays at the bottom unless the focused control would sit under it, and then takes the top', () => {
  assert.deepEqual(choosePlacement({ target: control(300, 340), boxes: SMALL }), HOME_PLACEMENT, 'a control clear of both stays put');
  assert.deepEqual(choosePlacement({ target: control(100, 140), boxes: SMALL }), HOME_PLACEMENT, 'a control under the top edge only does not move it there');
  assert.deepEqual(choosePlacement({ target: control(492, 540), boxes: SMALL }), { edge: 'top', compact: false }, 'the read button under the bottom panel');
});

test('with enlarged text, when both edges would hide the control completely, the panel takes its compact form', () => {
  // The page selector after moving from the feed to Settings: under the panel at either edge.
  assert.deepEqual(choosePlacement({ target: control(338, 403), boxes: TALL }), { edge: 'bottom', compact: true });
  // Under the compact bottom form too: the top one is clear of it.
  assert.deepEqual(choosePlacement({ target: control(490, 540), boxes: { full: { bottom: across(124, 556), top: across(64, 548) }, compact: TALL.compact } }), { edge: 'top', compact: true });
});

test('a control the panel cannot cover entirely never shrinks it: the full panel goes where it covers least', () => {
  // The page container that takes focus after a route change is as large as the screen.
  assert.deepEqual(choosePlacement({ target: { left: 0, right: 320, top: 64, bottom: 568 }, boxes: TALL }), HOME_PLACEMENT);
  assert.deepEqual(choosePlacement({ target: { left: 0, right: 320, top: 64, bottom: 568 }, boxes: SMALL }), HOME_PLACEMENT);
  // Partly under both full panels, wholly under neither: the one that covers less.
  assert.deepEqual(choosePlacement({ target: control(100, 540), boxes: TALL }), { edge: 'top', compact: false }, 'the top covers 397 of 440 rows, the bottom 416');
  assert.deepEqual(choosePlacement({ target: control(120, 500), boxes: TALL }), { edge: 'bottom', compact: false }, 'the bottom covers one row less: home');
});

// A panel whose geometry follows the placement it is given, as the DOM's does.
function fakePanel({ focus, boxes }: { focus: { current: FocusState }; boxes: typeof SMALL }) {
  const log = { measured: [] as Placement[], applied: [] as Placement[] };
  const placer = createNudgePlacer({
    focus: () => focus.current,
    measure: (placement) => {
      log.measured.push(placement);
      return boxes[placement.compact ? 'compact' : 'full'][placement.edge];
    },
    apply: (placement) => { log.applied.push(placement); },
  });
  return { placer, log };
}

test('focus on a control of the page places the panel, and focus going away sends it home', () => {
  const focus = { current: { kind: 'control', box: control(492, 540) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', compact: false });
  focus.current = { kind: 'none' };
  placer.place();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT);
});

test('focus inside the panel keeps it where it is: the panel at the top does not jump to the bottom under the reader\'s finger', () => {
  const focus = { current: { kind: 'control', box: control(492, 540) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', compact: false });
  const placed = log.applied.length;
  const measured = log.measured.length;
  // Its own action or dismiss button takes focus.
  focus.current = { kind: 'inside' };
  placer.place();
  assert.equal(log.applied.length, placed, 'nothing is applied');
  assert.equal(log.measured.length, measured, 'nothing is measured, so nothing flickers');
});

test('a press of the pointer holds the panel until it is released, then a change asked for meanwhile is made', () => {
  const focus = { current: { kind: 'none' } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  const placed = log.applied.length;
  placer.pointerDown(1);
  // The press focuses a control that would sit under the panel, and the next frame measures again.
  focus.current = { kind: 'control', box: control(492, 540) };
  placer.place();
  placer.place();
  assert.equal(log.applied.length, placed, 'the panel has not moved between press and release');
  placer.pointerUp(1);
  assert.deepEqual(log.applied.at(-1), { edge: 'top', compact: false });
  assert.equal(log.applied.length, placed + 1, 'one move, made at the release');
  placer.pointerUp(1);
  assert.equal(log.applied.length, placed + 1, 'a release with nothing waiting does nothing');
});

test('the reader can expand the compact form in place, and it stays while focus is inside it', () => {
  const focus = { current: { kind: 'control', box: control(338, 403) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: TALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', compact: true });
  placer.expand();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', compact: false }, 'the same edge, in full');
  focus.current = { kind: 'inside' };
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', compact: false }, 'it does not collapse under the reader while they use it');
  focus.current = { kind: 'control', box: control(338, 403) };
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', compact: true }, 'once focus is back on the page it is compact again');
});

test('with two fingers down the panel waits for both, and a press whose release never arrives does not hold it for good', () => {
  const focus = { current: { kind: 'none' } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  const placed = log.applied.length;
  placer.pointerDown(1);
  placer.pointerDown(2);
  focus.current = { kind: 'control', box: control(492, 540) };
  placer.place();
  placer.pointerUp(1);
  assert.equal(log.applied.length, placed, 'one finger is still down');
  placer.pointerUp(2);
  assert.equal(log.applied.length, placed + 1);
  // A context menu or a lost window focus: no pointerup ever comes.
  focus.current = { kind: 'none' };
  placer.pointerDown(3);
  placer.place();
  assert.equal(log.applied.length, placed + 1, 'held while the press is believed down');
  placer.releaseAll();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT, 'released, the waiting change is made');
  focus.current = { kind: 'control', box: control(492, 540) };
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', compact: false }, 'and later changes are no longer held');
});
