import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_SAFETY_MS, PAGE_MOTIONS, pageMotionFor } from './pageMotion.js';

/**
 * BEHAVIOUR tests for the pure table behind `PageTransition` (spec §7 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 * The rule: the deeper page goes on top, the other gives way underneath for
 * exactly as long as the page on top takes to arrive — so a held page is
 * named for the entrance above it. A page on its way out reads the
 * navigation that ejects it.
 */
const table = [
  // present, lateral, direction → motion
  [true, false, 1, 'enter'],
  [true, true, 1, 'enter-lateral'],
  [true, true, -1, 'enter-lateral'],
  [true, false, -1, 'reveal'],
  [true, false, 0, 'rest'],
  [true, true, 0, 'rest'],
  [false, true, 1, 'hold-lateral'],
  [false, true, -1, 'hold-lateral'],
  [false, false, 1, 'hold'],
  [false, false, -1, 'leave'],
  [false, false, 0, 'fade'],
  [false, true, 0, 'fade'],
];

for (const [present, lateral, direction, expected] of table) {
  test(`present=${present} lateral=${lateral} direction=${direction} → ${expected}`, () => {
    assert.equal(pageMotionFor({ present, lateral, direction }), expected);
  });
}

test('every answer is a declared motion, and every declared motion is reachable', () => {
  const seen = new Set(table.map(([present, lateral, direction]) => pageMotionFor({ present, lateral, direction })));
  for (const motion of seen) assert.ok(PAGE_MOTIONS.includes(motion), `${motion} is declared`);
  for (const motion of PAGE_MOTIONS) assert.ok(seen.has(motion), `${motion} is reachable`);
  assert.equal(PAGE_MOTIONS.length, 8);
});

test('out-of-range input reads as direction 0, not lateral, present', () => {
  assert.equal(pageMotionFor({ present: true, lateral: false, direction: 'left' }), 'rest');
  assert.equal(pageMotionFor({ present: false, lateral: false, direction: NaN }), 'fade');
  assert.equal(pageMotionFor({ present: true, lateral: 'yes', direction: 1 }), 'enter');
  assert.equal(pageMotionFor({ lateral: false, direction: 1 }), 'enter', 'no presence context means present');
  assert.equal(pageMotionFor(), 'rest');
  // A magnitude is only a sign: history moves one step at a time.
  assert.equal(pageMotionFor({ present: true, lateral: false, direction: 3 }), 'enter');
  assert.equal(pageMotionFor({ present: false, lateral: false, direction: -2 }), 'leave');
});

test('the safety clock is a whole number of milliseconds a timer can take', () => {
  assert.ok(Number.isInteger(EXIT_SAFETY_MS) && EXIT_SAFETY_MS > 0);
  assert.equal(EXIT_SAFETY_MS, 700);
});
