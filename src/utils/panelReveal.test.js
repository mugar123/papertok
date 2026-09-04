import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PANEL_REVEAL_ZONE_PX,
  panelShouldShow,
  pointerWakesPanel,
} from './panelReveal.js';

test('the panel is up before the first scroll, so it can be found', () => {
  assert.equal(panelShouldShow({ canHover: true, hasScrolled: false }), true);
});

test('starting to read puts it away', () => {
  assert.equal(panelShouldShow({ canHover: true, hasScrolled: true }), false);
});

test('a touch screen never hides it — there is no hover to ask with', () => {
  assert.equal(panelShouldShow({ canHover: false, hasScrolled: true }), true);
  assert.equal(
    panelShouldShow({ canHover: false, hasScrolled: true, nearBottom: false, holdsFocus: false }),
    true,
  );
});

test('the pointer in the strip brings it back', () => {
  assert.equal(panelShouldShow({ canHover: true, hasScrolled: true, nearBottom: true }), true);
});

test('keyboard focus holds it open, or tabbing lands on something invisible', () => {
  assert.equal(panelShouldShow({ canHover: true, hasScrolled: true, holdsFocus: true }), true);
});

test('the strip reaches exactly as far up as it says', () => {
  const viewport = 800;
  assert.equal(pointerWakesPanel(viewport - PANEL_REVEAL_ZONE_PX, viewport), true);
  assert.equal(pointerWakesPanel(viewport - PANEL_REVEAL_ZONE_PX - 1, viewport), false);
  assert.equal(pointerWakesPanel(viewport, viewport), true);
  assert.equal(pointerWakesPanel(0, viewport), false);
});

test('a height it cannot measure never wakes the panel', () => {
  assert.equal(pointerWakesPanel(undefined, 800), false);
  assert.equal(pointerWakesPanel(700, undefined), false);
  assert.equal(pointerWakesPanel(Number.NaN, 800), false);
});
