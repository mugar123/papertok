import test from 'node:test';
import assert from 'node:assert/strict';

import { HOME_PLACEMENT, bindNudgePlacement, choosePlacement, clipToViewport, createNudgePlacer, fitsOnScreen, restoreTarget, type Edge, type FocusState, type Placement, type ScreenBox } from './nudge-placement.ts';

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
  // A 320 x 320 screen where the panel just fits (244 px in 64-308) and covers any control at either edge.
  const SHORT: Record<Edge, ScreenBox> = { bottom: across(64, 308), top: across(64, 308) };
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

// A panel whose geometry follows the edge it is given, as the DOM's does: `dom.edge` is what the page would show,
// written by both measuring and applying.
function fakePanel({ focus, boxes, onRestore }: { focus: { current: FocusState }; boxes: Record<Edge, ScreenBox> | (() => Record<Edge, ScreenBox>); onRestore?: () => void }) {
  const log = { measured: [] as Edge[], applied: [] as Placement[], restored: [] as unknown[], order: [] as string[], dom: { edge: 'bottom' as Edge } };
  const placer = createNudgePlacer({
    focus: () => focus.current,
    measure: (edge) => {
      log.dom.edge = edge;
      log.measured.push(edge);
      return (typeof boxes === 'function' ? boxes() : boxes)[edge];
    },
    apply: (placement) => { log.dom.edge = placement.edge; log.applied.push(placement); log.order.push('apply'); },
    restoreFocus: (origin) => {
      log.restored.push(origin);
      log.order.push('restore');
      focus.current = origin === undefined ? { kind: 'none' } : { kind: 'control', box: control(10, 20), ref: origin };
      onRestore?.();
    },
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

test('focus inside the panel keeps it where it is: the panel at the top does not jump to the bottom under a finger', () => {
  const focus = { current: { kind: 'control', box: control(492, 540) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: SMALL });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  const decided = log.applied.length;
  // Its own action or dismiss button takes focus; scrolling or a resize asks for a decision again.
  focus.current = { kind: 'inside' };
  placer.place();
  placer.place();
  assert.equal(log.applied.length, decided + 2, 'each decision ends in an apply');
  assert.ok(log.applied.slice(-2).every(placement => placement.edge === 'top' && !placement.hidden), 'it ends each decision where it was: at the top, shown');
  assert.equal(log.dom.edge, 'top', 'measuring both edges left the panel at its own');
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
  const layout = { notify: null as { size: () => void; content: () => void } | null, stopped: 0 };
  return {
    doc,
    win,
    frames,
    cancelled,
    layout,
    observeLayout: (notify: { size: () => void; content: () => void }) => {
      layout.notify = notify;
      return () => { layout.stopped += 1; };
    },
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

// The 320 x 568 window at 200% text: the notice is about 436 px tall, 120-556 at the bottom edge and 64-500 at the top.
const TALL_436: Record<Edge, ScreenBox> = { bottom: across(120, 556), top: across(64, 500) };

test('a panel taller than the room between its edges is hidden, and the window growing brings it back', () => {
  assert.equal(fitsOnScreen(TALL_436), true, '436 px fits in 64-556');
  // The window drops to 320 px high: the bottom edge ends at 308, so the room is 64-308 = 244 px.
  const SHORT_436: Record<Edge, ScreenBox> = { bottom: across(-128, 308), top: across(64, 500) };
  assert.equal(fitsOnScreen(SHORT_436), false);
  assert.deepEqual(choosePlacement({ target: control(150, 190), boxes: SHORT_436 }), { edge: 'bottom', hidden: true }, 'even for a control it does not touch');
  // The email notice at 320 x 256 with enlarged text: about 190 px in 64-236.
  assert.equal(fitsOnScreen({ bottom: across(46, 236), top: across(64, 254) }), false);
  // A panel of 120 px in the same window fits.
  assert.equal(fitsOnScreen({ bottom: across(116, 236), top: across(64, 184) }), true);
});

test('with nothing focused a panel that does not fit is hidden, and shown when the window grows', () => {
  const focus = { current: { kind: 'none' } as FocusState };
  const room = { current: { bottom: across(-128, 308), top: across(64, 500) } as Record<Edge, ScreenBox> };
  const { placer, log } = fakePanel({ focus, boxes: () => room.current });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true });
  room.current = TALL_436;
  placer.place();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT);
});

test('focus inside a panel whose window shrinks under it hides the panel rather than leave its controls off screen', () => {
  // The verifier's case: the panel is at the top and its action has focus, then the window drops from 568 to 320 px high.
  const focus = { current: { kind: 'control', box: control(530, 560) } as FocusState };
  const room = { current: TALL_436 };
  const { placer, log } = fakePanel({ focus, boxes: () => room.current });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  focus.current = { kind: 'inside' };
  room.current = { bottom: across(-128, 308), top: across(64, 500) };
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: true }, 'hidden, keeping the edge it was at');
  // The window grows again: focus is no longer inside (hidden panels are inert), so the decision is about the page.
  focus.current = { kind: 'none' };
  room.current = TALL_436;
  placer.place();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT);
});

test('a layout change under a control that keeps focus, with no focus, scroll or resize, places the panel again a frame later', () => {
  // The verifier's probe: the focused control sits at 500-565, clear of the panel at the top (64-500); then content above it
  // changes and it is at 338-403, entirely under the panel at both edges. Nothing but the layout notice follows.
  const focus = { current: { kind: 'control', box: control(500, 565) } as FocusState };
  const { placer, log } = fakePanel({ focus, boxes: TALL_436 });
  const page = fakePage();
  const unbind = bindNudgePlacement(placer, page);
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  const before = log.applied.length;

  focus.current = { kind: 'control', box: control(338, 403) };
  assert.ok(page.layout.notify, 'the placement asked to be told of layout changes');
  page.layout.notify?.content();
  page.layout.notify?.content();
  page.layout.notify?.content();
  assert.equal(log.applied.length, before, 'not in the middle of the frame');
  assert.equal(page.frames.length, 1, 'any number of notices cost one frame');
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true }, 'covered at both edges: hidden');

  // A notice while a press is down waits for the release, like a scroll.
  focus.current = { kind: 'control', box: control(500, 565) };
  const held = log.applied.length;
  page.doc.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 4 }));
  page.layout.notify?.content();
  page.runFrame();
  assert.equal(log.applied.length, held);
  page.doc.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 4 }));
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });

  assert.equal(page.layout.stopped, 0);
  unbind();
  assert.equal(page.layout.stopped, 1, 'unbinding stops watching the layout');
});

test('a content notice decides only when a control of the page has focus, a size notice always does', () => {
  const focus = { current: { kind: 'none' } as FocusState };
  const room = { current: TALL_436 };
  const { placer, log } = fakePanel({ focus, boxes: () => room.current });
  const page = fakePage();
  const unbind = bindNudgePlacement(placer, page);
  placer.place();
  const measured = log.measured.length;

  // Nothing focused, or focus inside the panel: content changes cannot matter, so nothing is measured.
  page.layout.notify?.content();
  page.runFrame();
  focus.current = { kind: 'inside' };
  page.layout.notify?.content();
  page.runFrame();
  assert.equal(log.measured.length, measured, 'a page that changes all the time costs nothing while no control of it has focus');

  // A size notice always decides: the window shrank, and the panel no longer fits.
  focus.current = { kind: 'none' };
  room.current = { bottom: across(-128, 308), top: across(64, 500) };
  page.layout.notify?.size();
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true });

  // A control of the page with focus: a content notice decides, and one size notice in the same frame makes it a full decision.
  room.current = TALL_436;
  focus.current = { kind: 'control', box: control(338, 403) };
  page.layout.notify?.content();
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true }, 'covered at both edges');
  focus.current = { kind: 'none' };
  page.layout.notify?.content();
  page.layout.notify?.size();
  assert.equal(page.frames.length, 1, 'both ask for one frame');
  page.runFrame();
  assert.deepEqual(log.applied.at(-1), HOME_PLACEMENT, 'the size notice made it a full decision: shown at home');
  unbind();
});

test('hiding a panel that holds focus puts focus back on the page control it came from, before the panel goes inert', () => {
  // Focus was on a page control, then Tab took it into the panel's action; the window then drops to 320 px high.
  const focus = { current: { kind: 'control', box: control(530, 560), ref: 'read button' } as FocusState };
  const room = { current: TALL_436 };
  const { placer, log } = fakePanel({ focus, boxes: () => room.current });
  placer.place();
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: false });
  focus.current = { kind: 'inside' };
  placer.place();
  assert.deepEqual(log.restored, [], 'while the panel fits, focus inside it is left alone');

  room.current = { bottom: across(-128, 308), top: across(64, 500) };
  log.order.length = 0;
  placer.place();
  assert.deepEqual(log.restored, ['read button'], 'focus goes back to the control it came from');
  assert.deepEqual(log.order, ['restore', 'apply'], 'before the panel is hidden, so an inert panel never holds it');
  assert.deepEqual(focus.current, { kind: 'control', box: control(10, 20), ref: 'read button' }, 'and that is where it lands');
  assert.deepEqual(log.applied.at(-1), { edge: 'top', hidden: true });
});

test('focus that entered the panel with no page control before it is restored to the fallback, and the restoring does not loop', () => {
  const focus = { current: { kind: 'inside' } as FocusState };
  const room = { current: { bottom: across(-128, 308), top: across(64, 500) } as Record<Edge, ScreenBox> };
  // Putting focus back sends a focusin, which asks to place again in the middle of the decision.
  const refs: { placer?: ReturnType<typeof fakePanel>['placer'] } = {};
  const { placer, log } = fakePanel({ focus, boxes: () => room.current, onRestore: () => refs.placer?.place() });
  refs.placer = placer;
  placer.place();
  assert.deepEqual(log.restored, [undefined], 'no origin: the page decides where, by restoreTarget');
  assert.equal(log.applied.length, 1, 'the nested request did not decide again');
  assert.deepEqual(log.applied.at(-1), { edge: 'bottom', hidden: true });
});

test('focus returns to the control it came from while that is on the page, else to the page container, else nowhere', () => {
  const read = { id: 'read button', connected: true };
  const container = { id: 'main-content', connected: true };
  const usable = (element: { connected: boolean }) => element.connected;
  assert.equal(restoreTarget(read, { usable, fallback: () => container }), read);
  read.connected = false;
  assert.equal(restoreTarget(read, { usable, fallback: () => container }), container, 'the control is gone: the page container');
  assert.equal(restoreTarget(undefined, { usable, fallback: () => container }), container, 'focus never came from a page control');
  assert.equal(restoreTarget(undefined, { usable, fallback: () => null }), null, 'no container either: left to the browser');
});

test('focus that left the page controls before the panel was entered has no origin to go back to', () => {
  // A card button had focus, a click on plain text dropped it to the page, then a click put focus in the panel's X.
  const focus = { current: { kind: 'control', box: control(300, 340), ref: 'card button' } as FocusState };
  const room = { current: SMALL };
  const { placer, log } = fakePanel({ focus, boxes: () => room.current });
  placer.place();
  focus.current = { kind: 'none' };
  placer.place();
  focus.current = { kind: 'inside' };
  room.current = { bottom: across(-128, 308), top: across(64, 500) };
  placer.place();
  assert.deepEqual(log.restored, [undefined], 'not the card button focus left long ago');
});
