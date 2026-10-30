import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { dismissPersistentToasts, listenForToastEscape, toastError } from './toast.ts';

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

// The search palette fills a phone's screen and traps focus; an error toast
// raised before it opened sat over its rows' Follow, and Escape there closes
// the palette, not the toast. Opening it puts such a toast away.
test('the toasts that stay until closed can be put away without Escape, keeping the ones that leave on their own', () => {
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const errors = [toastError('Could not follow Nature. Try again.'), toastError('The list could not be deleted')];
  dismissPersistentToasts();
  assert.ok(onScreen(undo), 'the Undo toast is still on screen');
  assert.deepEqual(errors.map(onScreen), [false, false], 'both error toasts were put away');
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
