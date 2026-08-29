import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBarVisibility } from './scrollDirection.js';

const T = 8;

test('bajar esconde la barra; subir la devuelve', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 140, visible: true, threshold: T }), false);
  assert.equal(nextBarVisibility({ previousTop: 140, currentTop: 100, visible: false, threshold: T }), true);
});

test('un movimiento por debajo del umbral no cambia nada: es temblor, no intención', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 104, visible: true, threshold: T }), true);
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 96, visible: false, threshold: T }), false);
});

test('quedarse quieto NO devuelve la barra', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 100, visible: false, threshold: T }), false);
});

test('en el borde superior la barra vuelve', () => {
  assert.equal(nextBarVisibility({ previousTop: 4, currentTop: 0, visible: false, threshold: T }), true);
});

test('exactamente en el umbral ya es intención, no temblor: pin de la lectura <, no <=', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 108, visible: true, threshold: T }), false);
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 92, visible: false, threshold: T }), true);
});

test('un currentTop negativo (rebote de iOS) sigue siendo el borde superior', () => {
  assert.equal(nextBarVisibility({ previousTop: 50, currentTop: -10, visible: false, threshold: T }), true);
});
