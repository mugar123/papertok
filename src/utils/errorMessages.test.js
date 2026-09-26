import test from 'node:test';
import assert from 'node:assert/strict';
import { getUiErrorMessage } from './errorMessages.js';

test('localizes stable error codes', () => {
  assert.equal(
    getUiErrorMessage('ENTITY_LOAD_FAILED'),
    'This entity could not be loaded. Check your connection and try again.',
  );
});

test('never exposes an unknown Spanish message in the English interface', () => {
  assert.equal(
    getUiErrorMessage('No se pudo conectar con el proveedor.', 'FEED_LOAD_FAILED'),
    'Papers could not be loaded. Check your connection and try again.',
  );
});

test('supports provider error objects without exposing their raw message', () => {
  assert.equal(
    getUiErrorMessage({ code: 'auth/popup-blocked', message: 'raw provider copy' }, 'AUTH_FAILED'),
    'The browser blocked the sign-in window.',
  );
});
