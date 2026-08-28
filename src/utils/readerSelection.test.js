import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSelectionRoute, isUsableSelection, SELECTION_SETTLE_MS } from './readerSelection.js';

test('puntero grueso decide la barra; el fino conserva el menú de escritorio', () => {
  assert.equal(pickSelectionRoute({ coarsePointer: true }), 'bar');
  assert.equal(pickSelectionRoute({ coarsePointer: false }), 'menu');
});

test('una selección vacía, colapsada o sin rango no es utilizable', () => {
  assert.equal(isUsableSelection({ isCollapsed: true, rangeCount: 1, text: 'hola' }), false);
  assert.equal(isUsableSelection({ isCollapsed: false, rangeCount: 0, text: 'hola' }), false);
  assert.equal(isUsableSelection({ isCollapsed: false, rangeCount: 1, text: '   ' }), false);
  assert.equal(isUsableSelection({ isCollapsed: false, rangeCount: 1, text: 'hola' }), true);
});

test('el retardo de asentamiento es una constante con nombre, no un número suelto', () => {
  assert.equal(typeof SELECTION_SETTLE_MS, 'number');
  assert.ok(SELECTION_SETTLE_MS >= 150 && SELECTION_SETTLE_MS <= 400);
});
