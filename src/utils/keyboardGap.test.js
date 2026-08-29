import test from 'node:test';
import assert from 'node:assert/strict';
import { measureKeyboardGap } from './keyboardGap.js';

test('sin teclado ni desajuste, el hueco es cero', () => {
  assert.equal(
    measureKeyboardGap({ innerHeight: 812, viewportHeight: 812, viewportOffsetTop: 0 }),
    0,
  );
});

test('el teclado abierto encoge viewportHeight y eso es el hueco entero', () => {
  // iOS típicamente encoge `height` y deja `offsetTop` en 0 mientras el
  // teclado está arriba.
  assert.equal(
    measureKeyboardGap({ innerHeight: 812, viewportHeight: 490, viewportOffsetTop: 0 }),
    322,
  );
});

test('offsetTop resta del hueco igual que height: repartir el mismo total entre los dos términos da el mismo resultado', () => {
  // Repartir los mismos 120px "perdidos" entre encoger `height` y desplazar
  // `offsetTop` debe dar idéntico hueco: a la fórmula solo le importa la
  // suma de los dos, no cuál de ellos la aporta.
  const allInHeight = measureKeyboardGap({ innerHeight: 812, viewportHeight: 692, viewportOffsetTop: 0 });
  const splitBetweenBoth = measureKeyboardGap({ innerHeight: 812, viewportHeight: 600, viewportOffsetTop: 92 });
  assert.equal(allInHeight, 120);
  assert.equal(splitBetweenBoth, 120);
  assert.equal(allInHeight, splitBetweenBoth);
});

test('un hueco negativo (ruido de redondeo, o el visual viewport igualando el de layout) se recorta a cero', () => {
  assert.equal(
    measureKeyboardGap({ innerHeight: 812, viewportHeight: 812.4, viewportOffsetTop: 0 }),
    0,
  );
  assert.equal(
    measureKeyboardGap({ innerHeight: 800, viewportHeight: 812, viewportOffsetTop: 0 }),
    0,
  );
});

test('el borde exacto (gap === 0) es el caso estable, no un caso límite tratado aparte', () => {
  assert.equal(
    measureKeyboardGap({ innerHeight: 700, viewportHeight: 700, viewportOffsetTop: 0 }),
    0,
  );
});

test('un teclado grande en un teléfono más alto da el hueco real, sin tope artificial', () => {
  assert.equal(
    measureKeyboardGap({ innerHeight: 926, viewportHeight: 566, viewportOffsetTop: 0 }),
    360,
  );
});
