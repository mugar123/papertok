import test from 'node:test';
import assert from 'node:assert/strict';
import { pickThemeRoute } from './theme-transition.ts';

test('reduced motion manda: instantáneo aunque haya VT', () => {
  assert.equal(pickThemeRoute({ reducedMotion: true, hasViewTransitions: true }), 'instant');
});

test('sin View Transitions el cambio es instantáneo, no una tormenta de transiciones', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: false }), 'instant');
});

/**
 * Medido el 11-09-2026 en escritorio: el barrido circular iba a 60 fps pero
 * su borde duro se leía como un corte; toda transición CSS de color lo
 * bastante amplia para no dejar nada cambiando de golpe caía a 8-9 fps.
 * Un crossfade compuesto en GPU es lo único que es suave en todas partes.
 */
test('con VT el cambio es un crossfade, en cualquier puntero', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: true }), 'fade');
});
