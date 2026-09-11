import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickThemeRoute } from './themeTransition.js';

test('reduced motion manda: instantáneo aunque haya VT', () => {
  assert.equal(pickThemeRoute({ reducedMotion: true, hasViewTransitions: true, coarsePointer: false }), 'instant');
});

test('sin View Transitions el cambio es instantáneo, no una tormenta de transiciones', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: false, coarsePointer: true }), 'instant');
});

test('puntero grueso: crossfade corto, nunca el barrido', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: true, coarsePointer: true }), 'fade');
});

test('desktop con VT conserva el barrido de tinta', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: true, coarsePointer: false }), 'sweep');
});

test('SOURCE: el barrido del tema dura 260/200 ms', async () => {
  const css = await readFile(new URL('../styles/global.css', import.meta.url), 'utf8');
  assert.match(css, /animation: themeSweepIn 260ms/);
  assert.match(css, /animation: themeSweepOut 200ms/);
});
