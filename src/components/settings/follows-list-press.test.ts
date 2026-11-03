import type { ToastT } from 'sonner';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { sayFollowRefused } from '../following/follow-refused-toast.ts';
import { forgetAccountToasts, trackModalOverlay } from '../ui/toast.ts';
import { followsListPress, unfollowOnLeave } from './follows-list-press.ts';

// Opening an overlay dismisses toasts, which Sonner announces on the next frame; Node has no frames.
globalThis.requestAnimationFrame ??= (callback) => Number(setTimeout(() => callback(0), 0));
globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

/**
 * An overlay's portal ref, as Base UI calls it on opening; the cleanup is
 * called once its leave has played, and `startLeaving` marks its popup
 * closed as the leave starts. Node has no DOM: the portal's page draws no
 * toast list.
 */
function openOverlay() {
  let closed = false;
  const popup = { hasAttribute: (name: string) => name === 'data-closed' && closed };
  const portal = {
    ownerDocument: { querySelector: () => null },
    querySelector: (selector: string) => (selector === '[data-slot$="-content"]' ? popup : null),
  };
  const close = trackModalOverlay(portal as unknown as HTMLElement)!;
  return Object.assign(close, { startLeaving: () => { closed = true; } });
}

/**
 * The refusal of the write a press started, settling after the reader left
 * the list. Returns the titles of the toasts it has put on screen so far.
 */
function refusedAfterLeaving(startedAt: ReturnType<typeof followsListPress>) {
  const before = new Set(toast.getToasts().map(entry => entry.id));
  sayFollowRefused({ message: 'Could not unfollow Nature.' }, { inView: () => false, showInLine: () => assert.fail('the list is not on screen'), startedAt });
  return () => toast.getToasts()
    .filter((entry): entry is ToastT => !before.has(entry.id) && !('dismiss' in entry && entry.dismiss))
    .map(entry => entry.title);
}

// Unfollow pressed in the question on the Follows page; the reader leaves the
// page and opens the search palette before the write is refused. A toast over
// the palette would sit outside its focus trap.
test('an Unfollow refused after the reader opened the palette waits for it to close', () => {
  const closeQuestion = openOverlay();
  const startedAt = followsListPress({ press: 'unfollow', inOpenSheet: false });
  closeQuestion();
  const closePalette = openOverlay();
  const shown = refusedAfterLeaving(startedAt);
  assert.deepEqual(shown(), [], 'nothing sits over the palette');
  closePalette();
  assert.deepEqual(shown(), ['Could not unfollow Nature.'], 'the refusal is on screen once the palette left');
  toast.dismiss();
});

// On a phone the list is a sheet, and the question stacks on it.
test('an Unfollow pressed in the phone sheet and refused after the palette opened waits for it to close', () => {
  const closeSheet = openOverlay();
  const closeQuestion = openOverlay();
  const startedAt = followsListPress({ press: 'unfollow', inOpenSheet: true });
  closeQuestion();
  closeSheet();
  const closePalette = openOverlay();
  const shown = refusedAfterLeaving(startedAt);
  assert.deepEqual(shown(), [], 'nothing sits over the palette');
  closePalette();
  assert.deepEqual(shown(), ['Could not unfollow Nature.'], 'the refusal is on screen once the palette left');
  toast.dismiss();
});

// The question leaves after Unfollow is pressed in it, and the reader opens
// the palette meanwhile: the write takes the press noted in the question.
test('the unfollow written once the question has left keeps the press noted in it', () => {
  const closeQuestion = openOverlay();
  const confirmedAt = followsListPress({ press: 'unfollow', inOpenSheet: false });
  closeQuestion.startLeaving();
  const closePalette = openOverlay();
  closeQuestion();
  const unfollow = unfollowOnLeave({ confirmedAt, unfollowing: 'Nature' });
  assert.ok(unfollow, 'the confirmed unfollow is written');
  assert.equal(unfollow.entity, 'Nature');
  const shown = refusedAfterLeaving(unfollow.startedAt);
  assert.deepEqual(shown(), [], 'nothing sits over the palette');
  closePalette();
  assert.deepEqual(shown(), ['Could not unfollow Nature.'], 'the refusal is on screen once the palette left');
  toast.dismiss();
});

test('a question cancelled, or left after the account changed, writes no unfollow', () => {
  forgetAccountToasts('reader-a');
  const confirmedAt = followsListPress({ press: 'unfollow', inOpenSheet: false });
  assert.equal(unfollowOnLeave({ confirmedAt: null, unfollowing: 'Nature' }), null, 'cancelled');
  forgetAccountToasts('reader-b');
  assert.equal(unfollowOnLeave({ confirmedAt, unfollowing: 'Nature' }), null, 'reader B would unfollow Nature');
});

/**
 * The refusal of the write a press started, settling while the list is on
 * screen: the Follows page, or the phone sheet (`inSheet`). `inView` says
 * whether it still is when the refusal is said. Returns what it has written
 * in the list's line and put in toasts so far.
 */
function refusedInView(startedAt: ReturnType<typeof followsListPress>, message: string, { inView = () => true, inSheet = false }: { inView?: () => boolean; inSheet?: boolean } = {}) {
  const before = new Set(toast.getToasts().map(entry => entry.id));
  const lines: string[] = [];
  sayFollowRefused({ message }, { inView, inOverlay: inSheet, showInLine: refused => lines.push(refused.message), startedAt });
  return () => ({
    lines: [...lines],
    toasts: toast.getToasts()
      .filter((entry): entry is ToastT => !before.has(entry.id) && !('dismiss' in entry && entry.dismiss))
      .map(entry => entry.title),
  });
}

// ENG-123, browser check at 343f4f0c: Unfollow pressed in the question on the
// Follows page; the reader opens the search palette, during the question's
// leave (a tap on a phone) or right after it, and the page stays mounted under
// it. The line was written at once under the palette, and nothing was said
// when the palette closed.
for (const opened of ['as the question leaves', 'after the question left']) {
  test(`an Unfollow refused under a palette opened ${opened} goes to the Follows line once the palette closes`, () => {
    const closeQuestion = openOverlay();
    const confirmedAt = followsListPress({ press: 'unfollow', inOpenSheet: false });
    closeQuestion.startLeaving();
    let closePalette = opened === 'as the question leaves' ? openOverlay() : null;
    closeQuestion();
    closePalette ??= openOverlay();
    const unfollow = unfollowOnLeave({ confirmedAt, unfollowing: 'Cell' });
    assert.ok(unfollow, 'the confirmed unfollow is written');
    const said = refusedInView(unfollow.startedAt, 'Could not unfollow Cell.');
    assert.deepEqual(said(), { lines: [], toasts: [] }, 'nothing is written under the palette');
    closePalette();
    assert.deepEqual(said(), { lines: ['Could not unfollow Cell.'], toasts: [] }, 'the line is written, and so announced, once the palette left');
  });
}

// On a phone the list is a sheet and the question stacks on it; the sheet
// stays open under the palette, and its line is where the refusal goes.
test('an Unfollow pressed in the phone sheet, refused under a palette opened since, goes to the sheet\'s line once the palette closes', () => {
  const closeSheet = openOverlay();
  const closeQuestion = openOverlay();
  const confirmedAt = followsListPress({ press: 'unfollow', inOpenSheet: true });
  closeQuestion.startLeaving();
  const closePalette = openOverlay();
  closeQuestion();
  const said = refusedInView(confirmedAt, 'Could not unfollow Cell.', { inSheet: true });
  assert.deepEqual(said(), { lines: [], toasts: [] }, 'nothing is written under the palette');
  closePalette();
  assert.deepEqual(said(), { lines: ['Could not unfollow Cell.'], toasts: [] }, 'the sheet\'s line once the palette left');
  closeSheet();
});

// Undo pressed on its toast while the Follows page is on screen, then the
// palette opened before the follow was refused.
test('an Undo refused under a palette opened since goes to the Follows line once the palette closes', () => {
  const startedAt = followsListPress({ press: 'undo', inOpenSheet: false });
  const closePalette = openOverlay();
  const said = refusedInView(startedAt, 'Could not follow Cell. Try again.');
  assert.deepEqual(said(), { lines: [], toasts: [] }, 'nothing is written under the palette');
  closePalette();
  assert.deepEqual(said(), { lines: ['Could not follow Cell. Try again.'], toasts: [] });
});

// Presses whose list is on top when they are refused: nothing to wait for.
test('a refusal with no overlay opened since the press goes to the line at once, on the page and in the open sheet', () => {
  const closeQuestion = openOverlay();
  const onPage = followsListPress({ press: 'unfollow', inOpenSheet: false });
  closeQuestion();
  assert.deepEqual(refusedInView(onPage, 'Could not unfollow Cell.')(), { lines: ['Could not unfollow Cell.'], toasts: [] }, 'Unfollow on the page');
  const closeSheet = openOverlay();
  const closeSheetQuestion = openOverlay();
  const inSheet = followsListPress({ press: 'unfollow', inOpenSheet: true });
  closeSheetQuestion();
  assert.deepEqual(refusedInView(inSheet, 'Could not unfollow Cell.', { inSheet: true })(), { lines: ['Could not unfollow Cell.'], toasts: [] }, 'Unfollow in the sheet');
  const undoInSheet = followsListPress({ press: 'undo', inOpenSheet: true });
  assert.deepEqual(refusedInView(undoInSheet, 'Could not follow Cell. Try again.', { inSheet: true })(), { lines: ['Could not follow Cell. Try again.'], toasts: [] }, 'Undo with the sheet open');
  closeSheet();
});

// The reader picks a result in the palette: the route leaves the Follows page
// as the palette plays its leave, and a line written then is never seen.
test('a refusal held under the palette goes to a toast when the reader left the list before it closed', () => {
  const closeQuestion = openOverlay();
  const startedAt = followsListPress({ press: 'unfollow', inOpenSheet: false });
  closeQuestion();
  const closePalette = openOverlay();
  let onPage = true;
  const said = refusedInView(startedAt, 'Could not unfollow Cell.', { inView: () => onPage });
  onPage = false;
  closePalette();
  assert.deepEqual(said(), { lines: [], toasts: ['Could not unfollow Cell.'] });
  toast.dismiss();
});

test('a refusal held under the palette is said nowhere once the account changed', () => {
  forgetAccountToasts('reader-c');
  const startedAt = followsListPress({ press: 'undo', inOpenSheet: false });
  const closePalette = openOverlay();
  const said = refusedInView(startedAt, 'Could not follow Cell. Try again.');
  forgetAccountToasts('reader-d');
  closePalette();
  assert.deepEqual(said(), { lines: [], toasts: [] }, 'reader D did not press it');
});

// The Undo toast outlives the phone sheet: pressed while the sheet plays its
// leave, the sheet no longer counts as open, though its portal is still there.
test('an Undo pressed as the phone sheet leaves, refused after the palette opened, waits for it to close', () => {
  const closeSheet = openOverlay();
  closeSheet.startLeaving();
  const startedAt = followsListPress({ press: 'undo', inOpenSheet: false });
  const closePalette = openOverlay();
  closeSheet();
  const shown = refusedAfterLeaving(startedAt);
  assert.deepEqual(shown(), [], 'nothing sits over the palette');
  closePalette();
  assert.deepEqual(shown(), ['Could not unfollow Nature.'], 'the refusal is on screen once the palette left');
  toast.dismiss();
});
