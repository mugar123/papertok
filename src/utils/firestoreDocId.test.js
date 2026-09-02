import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFirestoreDocId, encodeFirestoreDocId } from './firestoreDocId.js';
import { decodeInteractionDocId, encodeInteractionDocId } from './interactionDocId.js';

test('the generic encoder is the one the interaction documents already use', () => {
  assert.equal(encodeInteractionDocId, encodeFirestoreDocId);
  assert.equal(decodeInteractionDocId, decodeFirestoreDocId);
});

test('a saved-paper id with a slash round-trips through a legal document name', () => {
  const encoded = encodeFirestoreDocId('hep-th/0603001');
  assert.ok(!encoded.includes('/'));
  assert.equal(decodeFirestoreDocId(encoded), 'hep-th/0603001');
  assert.equal(encodeFirestoreDocId('openalex:W1'), 'openalex:W1');
});
