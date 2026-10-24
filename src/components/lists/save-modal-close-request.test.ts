import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModalCloseRequest } from './save-modal-close-request.ts';

const idle = { saving: false, open: true, dirty: false, confirmingDiscard: false };

test('Escape with unsaved changes asks to discard them instead of closing', () => {
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'escape-key', dirty: true }), 'confirmDiscard');
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'outside-press', dirty: true }), 'confirmDiscard');
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'close-press', dirty: true }), 'confirmDiscard');
});

test('with the discard prompt on screen, the X closes but Escape and the scrim keep asking', () => {
  const asking = { ...idle, dirty: true, confirmingDiscard: true };
  assert.equal(saveModalCloseRequest({ ...asking, reason: 'close-press' }), 'close');
  assert.equal(saveModalCloseRequest({ ...asking, reason: 'escape-key' }), 'confirmDiscard');
  assert.equal(saveModalCloseRequest({ ...asking, reason: 'outside-press' }), 'confirmDiscard');
});

test('without unsaved changes any dismissal closes', () => {
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'escape-key' }), 'close');
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'close-press' }), 'close');
});

test('nothing closes while a save runs or once the window is already closing', () => {
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'escape-key', saving: true }), 'ignore');
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'close-press', dirty: true, confirmingDiscard: true, saving: true }), 'ignore');
  assert.equal(saveModalCloseRequest({ ...idle, reason: 'escape-key', open: false }), 'ignore');
});
