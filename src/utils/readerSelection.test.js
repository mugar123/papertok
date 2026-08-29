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
  // El rango [150, 400] no es un hecho medido en un teléfono real — nadie lo
  // estableció así, es solo lo que parecía razonable al escribir esta prueba
  // (ver el comentario de SELECTION_SETTLE_MS en readerSelection.js: "a
  // starting value, to be tuned against a real phone"). Lo que esta prueba
  // sí demuestra: que el valor es un número con nombre, no un literal repetido
  // en cada sitio que lo usa, y que sigue en el orden de magnitud esperado (ni
  // milisegundos que se disparan entre dos ajustes del manejador, ni segundos
  // que hacen sentir la barra lenta). No demuestra que 250ms sea el valor
  // correcto para un dedo real — eso solo lo confirma el teléfono.
  assert.equal(typeof SELECTION_SETTLE_MS, 'number');
  assert.ok(SELECTION_SETTLE_MS >= 150 && SELECTION_SETTLE_MS <= 400);
});
