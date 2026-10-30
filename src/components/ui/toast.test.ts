import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { dismissToastsOnEscape, toastError } from './toast.ts';

// Sonner announces the dismissal of one toast on the next frame; Node has no frames.
globalThis.requestAnimationFrame ??= (callback) => Number(setTimeout(() => callback(0), 0));
globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

const escape = { key: 'Escape', defaultPrevented: false, isComposing: false };
const onScreen = (id: string | number) => toast.getToasts().some(shown => shown.id === id);

/**
 * An error toast stays until it is closed, and on a phone it can cover the
 * control that has focus. Escape has to reveal that control without moving
 * focus (WCAG 2.4.11), unless a dialog or menu already took the key.
 */
test('Escape puts away an error toast that stays until it is closed', () => {
  const id = toastError('Could not follow Nature. Try again.');
  assert.ok(onScreen(id), 'the toast is on screen');
  dismissToastsOnEscape(escape);
  assert.ok(!onScreen(id), 'Escape dismissed it');
});

test('an Escape a dialog or menu already took, another key, or one that ends a composition leaves the toast', () => {
  const id = toastError('Could not follow Nature. Try again.');
  dismissToastsOnEscape({ ...escape, defaultPrevented: true });
  dismissToastsOnEscape({ ...escape, key: 'Enter' });
  dismissToastsOnEscape({ ...escape, isComposing: true });
  assert.ok(onScreen(id), 'the toast is still on screen');
  toast.dismiss();
});

test('Escape keeps the toasts that leave on their own, such as an Undo or a loading message', () => {
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const loading = toast.loading('Saving');
  const error = toastError('Could not follow Nature. Try again.');
  dismissToastsOnEscape(escape);
  assert.ok(onScreen(undo), 'the Undo toast is still on screen');
  assert.ok(onScreen(loading), 'the loading toast is still on screen');
  assert.ok(!onScreen(error), 'the error toast was put away');
  toast.dismiss();
});
