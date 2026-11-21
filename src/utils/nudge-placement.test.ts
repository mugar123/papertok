import test from 'node:test';
import assert from 'node:assert/strict';

import { HOME_PLACEMENT, bindNudgePlacement, choosePlacement, clipToViewport, createNudgePlacer, type Edge, type FocusState, type Placement, type ScreenBox } from './nudge-placement.ts';

// A 320 x 568 screen. Under the navbar the top edge starts at 64 px; the bottom edge ends at 556 px.
const across = (top: number, bottom: number): ScreenBox => ({ left: 12, right: 308, top, bottom });
const control = (top: number, bottom: number): ScreenBox => ({ left: 20, right: 300, top, bottom });

// The panel at normal text size: 111 px tall.
const SMALL: Record<Edge, ScreenBox> = { bottom: across(445, 556), top: across(64, 175) };

// With text at 200% the notice is about 433 px tall: 124-556 at the bottom, 64-497 at the top.
const TALL: Record<Edge, ScreenBox> = { bottom: across(124, 556), top: across(64, 497) };

test('the panel stays at the bottom unless the focused control would sit under it, and then takes the top', () => {
  assert.deepEqual(choosePlacement({ target: control(300, 340), boxes: SMALL }), HOME_PLACEMENT, 'a control clear of both stays put');
  assert.deepEqual(choosePlacement({ target: control(100, 140), boxes: SMALL }), HOME_PLACEMENT, 'a control under the top edge only does not move it there');
  assert.deepEqual(choosePlacement({ target: control(492, 540), boxes: SMALL }), { edge: 'top', hidden: false }, 'the read button under the bottom panel');
});

test('with enlarged text, a control the panel would cover entirely at both edges hides it', () => {
  // The page selector after moving from the feed to Settings: under the 433 px panel at either edge.
  assert.deepEqual(choosePlacement({ target: control(338, 403), boxes: TALL }), { edge: 'bottom', hidden: true });
  // A 320 x 320 screen: the panel is taller than the screen, so any control is entirely under it.
  const SHORT: Record<Edge, ScreenBox> = { bottom: across(64, 308), top: across(64, 497) };
  assert.deepEqual(choosePlacement({ target: control(154, 219), boxes: SHORT }), { edge: 'bottom', hidden: true });
  // Clear of one edge: no need to hide.
  assert.deepEqual(choosePlacement({ target: control(500, 540), boxes: TALL }), { edge: 'top', hidden: false });
});

test('on a tie the panel stays at the bottom, and a control exactly the size of the panel is covered entirely at both edges only if both are', () => {
  const same: Record<Edge, ScreenBox> = { bottom: across(300, 400), top: across(300, 400) };
  assert.deepEqual(choosePlacement({ target: control(250, 450), boxes: same }), HOME_PLACEMENT, 'covered equally and partly: home');
  assert.deepEqual(choosePlacement({ target: across(300, 400), boxes: same }), { edge: 'bottom', hidden: true }, 'exactly the panel box, at both edges');
  assert.deepEqual(choosePlacement({ target: { left: 20, right: 20, top: 100, bottom: 500 }, boxes: same }), HOME_PLACEMENT, 'a zero-area target is never covered');
});

test('only the part of a control that is on screen counts', () => {
  const viewport = { width: 320, height: 568 };
  assert.deepEqual(clipToViewport({ left: -10, right: 330, top: -40, bottom: 700 }, viewport), { left: 0, right: 320, top: 0, bottom: 568 });
  assert.deepEqual(clipToViewport(control(100, 200), viewport), control(100, 200), 'inside: unchanged');
  // A tall control that runs off the bottom of the screen: its visible part, 500-568, is entirely under the panel at both edges.
  const tall = control(500, 900);
  const boxes: Record<Edge, ScreenBox> = { bottom: across(400, 568), top: across(64, 600) };
  assert.deepEqual(choosePlacement({ target: tall, boxes }), HOME_PLACEMENT, 'unclipped it is larger than the panel and never hides it');
  assert.deepEqual(choosePlacement({ target: clipToViewport(tall, viewport), boxes }), { edge: 'bottom', hidden: true }, 'clipped, what the reader sees of it is covered');
});

test('a control the panel cannot cover entirely never hides it: the panel goes where it covers least', () => {
  // The page container that takes focus after a route change is as large as the screen.
  assert.deepEqual(choosePlacement({ target: { left: 0, right: 320, top: 64, bottom: 568 }, boxes: TALL }), HOME_PLACEMENT);
  assert.deepEqual(choosePlacement({ target: { left: 0, right: 320, top: 64, bottom: 568 }, boxes: SMALL }), HOME_PLACEMENT);
  // Partly under both panels, wholly under neither: the one that covers less.
  assert.deepEqual(choosePlacement({ target: control(100, 540), boxes: TALL }), { edge: 'top', hidden: false }, 'the top covers 397 of 440 rows, the bottom 416');
  assert.deepEqual(choosePlacement({ target: control(120, 500), boxes: TALL }), { edge: 'bottom', hidden: false }, 'the bottom covers one row less: home');
});

// A panel whose geometry follows the edge it is given, as the DOM's does.
function fakePanel({ focus, boxes }: { focus: { current: FocusState }; boxes: Record<Edge, ScreenBox> | (() => Record<Edge, ScreenBox>) }) {
  const log = { measured: [] as Edge[], applied: [] as Placement[] };
  const placer = createNudgePlacer({
    focus: () => focus.current,
    measure: (edge) => {
      log.measured.push(edge);
      return (typeof boxes === 'function' ? boxes() : boxes)[edge];
    },
    apply: (placement) => { log.applied.push(placement); },
  });
  return { placer, log };
}

test('focus on a control of the page places the panel, and focus going away sends it home', () => {
  const focus = { current: { kind: 'control', box: control(492, 540) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  focus.current = { kind: 'none' };
  placer.place();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT);
});

test('focus inside the panel keeps it where it is: the panel at the top does not jump to the bottom under the reader\'s finger', () => {
  const focus = { current: { kind: 'control', box: control(492, 540) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  const placed = log.applied.length;
  const measured = log.measured.length;
  // Its own action or dismiss button takes focus.
  focus.current = { kind: 'inside' };
  placer.place();
  assert.equal(log.applied.length, placed, 'nothing is applied');
  assert.equal(log.measured.length, measured, 'nothing is measured, so nothing flickers');
});

test('a hidden panel comes back as soon as focus moves to a control it does not cover, or leaves the page controls', () => {
  const focus = { current: { kind: 'control', box: control(338, 403) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: TALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true });
  // Focus moves to a control only the bottom edge would cover.
  focus.current = { kind: 'control', box: control(520, 550) };
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false }, 'clear of the top edge: shown there');
  focus.current = { kind: 'control', box: control(338, 403) };
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true });
  focus.current = { kind: 'none' };
  placer.place();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT, 'with nothing focused it is shown at home');
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
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  assert.equal(log.applied.length, placed + 1, 'one move, made at the release');
  placer.pointerUp(1);
  assert.equal(log.applied.length, placed + 1, 'a release with nothing waiting does nothing');
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
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false }, 'and later changes are no longer held');
});

// The page as the wiring sees it: an event target for the document and one for the window, and a frame queue run by hand.
// It records how each listener was added, since an EventTarget fires at-target listeners whatever their phase.
class RecordingTarget extends EventTarget {
  added: { type: string; options: unknown }[] = [];
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    this.added.push({ type, options });
    super.addEventListener(type, listener, options);
  }
}

function fakePage() {
  const doc = new RecordingTarget();
  const win = new RecordingTarget();
  const frames: (() => void)[] = [];
  const cancelled: number[] = [];
  return {
    doc,
    win,
    frames,
    cancelled,
    requestFrame: (callback: () => void) => frames.push(callback),
    cancelFrame: (frame: number) => { cancelled.push(frame); },
    runFrame() {
      frames.splice(0).forEach(callback => callback());
    },
  };
}

test('scrolling a focused control under the panel moves or hides the panel, once a frame, also after the feed scrolls it into place', () => {
  // The Settings page selector, at 338-403, is clear of a 156 px panel at the top (64-220) until the page scrolls 200 px.
  const scrolled = { by: 0 };
  const focus = { current: { kind: 'control', box: control(338, 403) } as FocusState };
  const sizes = { current: { bottom: across(504, 556), top: across(64, 220) } as Record<Edge, ScreenBox> };
  const { placer, log } = fakePanel({ focus, boxes: () => sizes.current });
  const page = fakePage();
  const unbind = bindNudgePlacement(placer, page);
  placer.place();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT, 'clear at the start');

  // The page scrolls 200 px: the control is now at 138-203, entirely under the panel at the top, and the bottom is made tall.
  scrolled.by = 200;
  focus.current = { kind: 'control', box: control(338 - scrolled.by, 403 - scrolled.by) };
  sizes.current = { bottom: across(124, 556), top: across(64, 220) };
  const before = log.applied.length;
  page.doc.dispatchEvent(new Event('scroll'));
  page.doc.dispatchEvent(new Event('scroll'));
  page.doc.dispatchEvent(new Event('scroll'));
  assert.equal(log.applied.length, before, 'nothing is measured in the middle of the frame');
  assert.equal(page.frames.length, 1, 'three scroll events ask for one frame');
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true }, 'covered at both edges: hidden');
  assert.equal(log.applied.length, before + 1);

  // Scrolling back brings it out of hiding.
  focus.current = { kind: 'control', box: control(338, 403) };
  page.doc.dispatchEvent(new Event('scroll'));
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false }, 'clear of the top edge again: shown there');

  // The pointer-press lock holds scrolling too.
  const held = log.applied.length;
  page.doc.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 7 }));
  focus.current = { kind: 'control', box: control(138, 203) };
  page.doc.dispatchEvent(new Event('scroll'));
  page.runFrame();
  assert.equal(log.applied.length, held, 'not while a press is down');
  page.doc.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 7 }));
  assert.equal(log.applied.length, held + 1, 'made at the release');

  const scroll = page.doc.added.find(listener => listener.type === 'scroll');
  assert.deepEqual(scroll?.options, { capture: true, passive: true }, 'heard in the capture phase, so a scrolling container inside the feed counts, and passively');
  unbind();
  page.doc.dispatchEvent(new Event('scroll'));
  assert.equal(page.frames.length, 0, 'unbound, scrolling asks for nothing');
});

test('focus arriving places the panel at once and again a frame later, after the browser scrolls the control into view', () => {
  const focus = { current: { kind: 'none' } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  const page = fakePage();
  const unbind = bindNudgePlacement(placer, page);
  // focusin fires with the control still off screen...
  focus.current = { kind: 'control', box: control(700, 740) };
  page.doc.dispatchEvent(new Event('focusin'));
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT);
  // ...and the browser then scrolls it under the bottom panel.
  focus.current = { kind: 'control', box: control(492, 540) };
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  // A resize places it, a lost window focus and a context menu forget a press.
  const placed = log.applied.length;
  page.win.dispatchEvent(new Event('resize'));
  assert.equal(log.applied.length, placed + 1);
  page.doc.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1 }));
  focus.current = { kind: 'none' };
  page.win.dispatchEvent(new Event('resize'));
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false }, 'held while the press is believed down');
  page.win.dispatchEvent(new Event('blur'));
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT, 'the press was forgotten and the waiting change made');
  unbind();
});

test('a panel hidden for a covered control comes back when focus falls to the page without a focusin', () => {
  const focus = { current: { kind: 'control', box: control(338, 403) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: TALL });
  const page = fakePage();
  const unbind = bindNudgePlacement(placer, page);
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true });
  // A click on plain text blurs the control: focusout, and no focusin follows.
  focus.current = { kind: 'none' };
  page.doc.dispatchEvent(new Event('focusout'));
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true }, 'not in the middle of the event');
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT, 'a frame later it is shown again');
  unbind();
});
