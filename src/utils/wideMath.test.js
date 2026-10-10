import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenWidth,
  inlineMathNeedsScroll,
  KEY_STEP_PX,
  MIN_THUMB_PX,
  sliderKeyTarget,
  sliderThumbWidth,
  sliderValueText,
} from './wideMath.js';

test('an inline formula that can wrap between its runs stays on the line', () => {
  assert.equal(inlineMathNeedsScroll([120, 200, 180], 320), false);
});

test('an inline formula with one run wider than the line scrolls', () => {
  assert.equal(inlineMathNeedsScroll([40, 410, 60], 320), true);
});

test('an unmeasured column never turns a formula into a scroller', () => {
  assert.equal(inlineMathNeedsScroll([900], 0), false);
});

test('sub-pixel overflow is not overflow', () => {
  assert.equal(hiddenWidth(320.6, 320), 0);
  assert.equal(hiddenWidth(321, 320), 0);
  assert.equal(hiddenWidth(700, 320), 380);
});

test('the thumb shows the visible share of the formula, never below a 24px target', () => {
  assert.equal(sliderThumbWidth(300, 300, 600), 150);
  assert.equal(sliderThumbWidth(300, 300, 30000), MIN_THUMB_PX);
  assert.equal(sliderThumbWidth(300, 300, 300), 300);
});

test('the slider names where it is in words, not in pixels', () => {
  assert.equal(sliderValueText(0, 400), 'Start of formula');
  assert.equal(sliderValueText(200, 400), '50% across the formula');
  assert.equal(sliderValueText(400, 400), 'End of formula');
});

test('arrow keys move a few glyphs and stop at the ends', () => {
  assert.equal(sliderKeyTarget('ArrowRight', 0, 400), KEY_STEP_PX);
  assert.equal(sliderKeyTarget('ArrowLeft', 10, 400), 0);
  assert.equal(sliderKeyTarget('ArrowRight', 390, 400), 400);
  assert.equal(sliderKeyTarget('End', 0, 400), 400);
  assert.equal(sliderKeyTarget('Home', 300, 400), 0);
  assert.equal(sliderKeyTarget('Enter', 0, 400), null);
});
