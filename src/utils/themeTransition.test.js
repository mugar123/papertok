import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickThemeRoute } from './themeTransition.js';

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

test('SOURCE: el fundido dura 220 ms y el barrido ya no existe', async () => {
  const css = await readFile(new URL('../styles/global.css', import.meta.url), 'utf8');
  assert.match(css, /animation: themePlainFade 220ms/);
  assert.doesNotMatch(css, /themeSweep|--theme-sweep/);
  const js = await readFile(new URL('./themeTransition.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /markSweepOrigin|'sweep'/);
});
