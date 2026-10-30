import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { dismissToastsOnEscape, toastError } from './toast.ts';

const escape = { key: 'Escape', defaultPrevented: false, isComposing: false };

/**
 * An error toast stays until it is closed, and on a phone it can cover the
 * control that has focus. Escape has to reveal that control without moving
 * focus (WCAG 2.4.11), unless a dialog or menu already took the key.
 */
test('Escape puts away an error toast that stays until it is closed', () => {
  const id = toastError('Could not follow Nature. Try again.');
  assert.ok(toast.getToasts().some(shown => shown.id === id), 'the toast is on screen');
  dismissToastsOnEscape(escape);
  assert.ok(!toast.getToasts().some(shown => shown.id === id), 'Escape dismissed it');
});

test('an Escape a dialog or menu already took, another key, or one that ends a composition leaves the toast', () => {
  const id = toastError('Could not follow Nature. Try again.');
  dismissToastsOnEscape({ ...escape, defaultPrevented: true });
  dismissToastsOnEscape({ ...escape, key: 'Enter' });
  dismissToastsOnEscape({ ...escape, isComposing: true });
  assert.ok(toast.getToasts().some(shown => shown.id === id), 'the toast is still on screen');
  toast.dismiss();
});
