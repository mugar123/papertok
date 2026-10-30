import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { dropHeldErrors, openOverlayCount, trackModalOverlay, listenForToastEscape, toastError } from './toast.ts';

// Sonner announces the dismissal of one toast on the next frame; Node has no frames.
globalThis.requestAnimationFrame ??= (callback) => Number(setTimeout(() => callback(0), 0));
globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

const onScreen = (id: string | number) => toast.getToasts().some(shown => shown.id === id);

/**
 * The window as the Toaster listens to it: `taken` is a listener that handles
 * the key first, as a dialog, a menu or the search field clearing its query
 * does (`preventDefault`).
 */
function page({ taken = false } = {}) {
  const target = new EventTarget();
  if (taken) target.addEventListener('keydown', (event) => { event.preventDefault(); });
  const stop = listenForToastEscape(target);
  const press = (key: string, { isComposing = false } = {}) => {
    target.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key, isComposing }));
  };
  return { press, stop };
}

/**
 * An error toast stays until it is closed, and on a phone it can cover the
 * control that has focus. Escape has to reveal that control without moving
 * focus (WCAG 2.4.11), unless a dialog or menu already took the key.
 */
test('Escape puts away an error toast that stays until it is closed', () => {
  const { press, stop } = page();
  const id = toastError('Could not follow Nature. Try again.');
  assert.ok(onScreen(id), 'the toast is on screen');
  press('Escape');
  assert.ok(!onScreen(id), 'Escape dismissed it');
  stop();
});

test('an Escape a dialog or menu already took, another key, or one that ends a composition leaves the toast', () => {
  const id = toastError('Could not follow Nature. Try again.');
  const taken = page({ taken: true });
  taken.press('Escape');
  taken.stop();
  const plain = page();
  plain.press('Enter');
  plain.press('Escape', { isComposing: true });
  plain.stop();
  assert.ok(onScreen(id), 'the toast is still on screen');
  toast.dismiss();
});

test('Escape keeps the toasts that leave on their own, such as an Undo or a loading message', () => {
  const { press, stop } = page();
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const loading = toast.loading('Saving');
  const error = toastError('Could not follow Nature. Try again.');
  press('Escape');
  assert.ok(onScreen(undo), 'the Undo toast is still on screen');
  assert.ok(onScreen(loading), 'the loading toast is still on screen');
  assert.ok(!onScreen(error), 'the error toast was put away');
  stop();
  toast.dismiss();
});

/**
 * A dialog, alert dialog, drawer or sheet fills a phone's screen and traps
 * focus; an error toast raised before it opened sat over it, outside the trap,
 * and Escape there closes the overlay, not the toast. Each overlay's portal
 * takes this ref, which Base UI calls with the portal's element as the overlay
 * opens, and whose returned cleanup it calls once the overlay has left.
 */
const openOverlay = () => trackModalOverlay({} as HTMLElement)!;

test('opening an overlay puts away the toasts that stay until closed, keeping the ones that leave on their own', () => {
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const errors = [toastError('Could not follow Nature. Try again.'), toastError('The list could not be deleted')];
  const close = openOverlay();
  assert.ok(onScreen(undo), 'the Undo toast is still on screen');
  assert.deepEqual(errors.map(onScreen), [false, false], 'both error toasts were put away');
  close();
  assert.deepEqual(errors.map(onScreen), [false, false], 'closing the overlay does not bring them back');
  toast.dismiss();
});

// A Follow pressed on a page settles after the palette, or any other modal
// overlay, opened: its refusal waits for the overlays opened since to leave.
test('an error of an action started behind overlays opened since appears once they have left', () => {
  const closeSheet = openOverlay();
  const overlaysAtStart = openOverlayCount();
  const closePalette = openOverlay();
  const closeConfirmation = openOverlay();
  const error = toastError('Could not follow Nature. Try again.', { overlaysAtStart });
  assert.ok(!onScreen(error), 'nothing sits over the overlays opened after the press');
  closeConfirmation();
  assert.ok(!onScreen(error), 'the palette is still open');
  closePalette();
  assert.ok(onScreen(error), 'the error is on screen once both have left, over the sheet it was pressed in');
  closeSheet();
  toast.dismiss();
});

// Creating a public list in the save dialog whose publishing fails: the toast
// is the only answer to that action, so it must not wait for the dialog.
test('an error of an action taken in the open overlay appears at once', () => {
  const closeSaveDialog = openOverlay();
  const error = toastError('List created, but still private');
  assert.ok(onScreen(error), 'the error is on screen over its own dialog');
  closeSaveDialog();
  toast.dismiss();
});

test('an error of an action whose overlay has closed since appears at once', () => {
  const closePalette = openOverlay();
  const overlaysAtStart = openOverlayCount();
  closePalette();
  const error = toastError('Could not follow Nature. Try again.', { overlaysAtStart });
  assert.ok(onScreen(error), 'the error is on screen');
  toast.dismiss();
});

// Signed out from the account menu while a Follow's refusal waited behind it.
test('an error still waiting when the account changes is never shown', () => {
  const overlaysAtStart = openOverlayCount();
  const closeAccountMenu = openOverlay();
  const error = toastError('Could not follow Nature. Try again.', { overlaysAtStart });
  dropHeldErrors();
  closeAccountMenu();
  assert.ok(!onScreen(error), 'the reader signed in next does not see it');
});

test('an error raised with no overlay open appears at once', () => {
  openOverlay()();
  const error = toastError('The list could not be deleted');
  assert.ok(onScreen(error), 'the error toast is on screen');
  toast.dismiss();
});

test('once the Toaster stops listening, Escape leaves the toast', () => {
  const { press, stop } = page();
  stop();
  const id = toastError('Could not follow Nature. Try again.');
  press('Escape');
  assert.ok(onScreen(id), 'the toast is still on screen');
  toast.dismiss();
});
