import type { ToastT } from 'sonner';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { sayFollowRefused } from '../following/follow-refused-toast.ts';
import { trackModalOverlay } from '../ui/toast.ts';
import { followsListPress } from './follows-list-press.ts';

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
  sayFollowRefused({ message: 'Could not unfollow Nature.' }, { inView: false, showInLine: () => assert.fail('the list is not on screen'), startedAt });
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
