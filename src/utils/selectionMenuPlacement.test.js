import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPOSE_WIDTH,
  MENU_HEIGHT,
  MENU_WIDTH,
  placeSelectionMenu,
} from './selectionMenuPlacement.js';

const VIEWPORT = { width: 1280, height: 800 };

test('it hangs under the passage and lines up with its left edge', () => {
  const placed = placeSelectionMenu({ left: 300, top: 200, bottom: 220 }, VIEWPORT);
  assert.equal(placed.placement, 'below');
  assert.equal(placed.left, 300);
  assert.equal(placed.top, 228);
  assert.equal(placed.width, MENU_WIDTH);
});

test('with no room below, it flips above the passage', () => {
  const placed = placeSelectionMenu({ left: 300, top: 700, bottom: 720 }, VIEWPORT);
  assert.equal(placed.placement, 'above');
  assert.equal(placed.top, 700 - MENU_HEIGHT - 8);
});

test('a passage at the right edge does not push the menu off the page', () => {
  const placed = placeSelectionMenu({ left: 1260, top: 100, bottom: 120 }, VIEWPORT);
  assert.ok(placed.left + placed.width <= VIEWPORT.width);
});

test('a passage at the left edge keeps its margin', () => {
  const placed = placeSelectionMenu({ left: -40, top: 100, bottom: 120 }, VIEWPORT);
  assert.equal(placed.left, 10);
});

test('the composer is wider, and is clamped on that wider width', () => {
  const placed = placeSelectionMenu({ left: 1260, top: 100, bottom: 120 }, VIEWPORT, true);
  assert.equal(placed.width, COMPOSE_WIDTH);
  assert.ok(placed.left + COMPOSE_WIDTH <= VIEWPORT.width);
});

test('a viewport too short for either placement still yields a visible menu', () => {
  const placed = placeSelectionMenu({ left: 20, top: 40, bottom: 60 }, { width: 400, height: 300 });
  assert.ok(placed.top >= 10);
  assert.ok(placed.left >= 10);
});
