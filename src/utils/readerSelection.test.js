import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSelectionRoute } from './readerSelection.js';

test('puntero grueso decide la isla recortada; el fino conserva el menú de escritorio', () => {
  assert.equal(pickSelectionRoute({ coarsePointer: true }), 'bar');
  assert.equal(pickSelectionRoute({ coarsePointer: false }), 'menu');
});
