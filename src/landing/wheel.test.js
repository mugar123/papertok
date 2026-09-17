import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source, like the other tests in this directory that gate a file's shape
// rather than its runtime behaviour — motion.js only ever runs in a browser
// (rAF, IntersectionObserver, real layout), so there is nothing here for
// node:test to execute. Comments stripped the same way page.test.js strips
// landing.css's, so a fact stated only in prose can't fool a regex that
// happens to also match the word inside it.
const js = readFileSync(fileURLToPath(new URL('./motion.js', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

test('the wheel keeps its measured constants', () => {
  assert.match(js, /WHEEL_REACHES = \[14, 16, 18\]/);
  assert.match(js, /WHEEL_TAU = 380/);
  assert.match(js, /WHEEL_STOP_V = 0\.46/);
});

test('the wheel turns on arrival by IntersectionObserver and on click, and never captures the scroll', () => {
  assert.match(js, /new IntersectionObserver\([\s\S]*?threshold: 0\.5/);
  assert.match(js, /frame\.addEventListener\('click'/);
  assert.doesNotMatch(js, /preventDefault/);
  assert.doesNotMatch(js, /addEventListener\('wheel'/);
  assert.doesNotMatch(js, /lp-scroller/);
});

// motion.js is a module (not the prototype's IIFE) precisely so a later
// task can import from it instead of duplicating a function — see task 10,
// which needs the same reduced-motion/viewport gate the hero deck arms
// under. A file that forgot to export anything would make that a copy-paste
// job instead, which is the defect this guards against.
test('shouldAnimate is an importable export, not trapped in a closure', () => {
  assert.match(js, /export function shouldAnimate\(/);
});

// The whole file, not just the wheel, is a module: no IIFE wrapper left over
// from the prototype this was copied out of.
test('not an IIFE', () => {
  assert.doesNotMatch(js, /^\s*\(function\s*\(\)\s*\{/);
  assert.doesNotMatch(js, /\}\)\(\);\s*$/);
});
