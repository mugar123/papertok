import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for the route transition.
 */
test('a page arrives and leaves on opacity and a slide, with no scale to re-raster at the end', async () => {
  const jsx = await read('./PageTransition.jsx');
  const variants = jsx.slice(jsx.indexOf('const routeVariants = {'), jsx.indexOf('const reducedMotionVariants'));
  assert.doesNotMatch(variants, /scale:/, 'no scale in the route variants');
  assert.match(variants, /x: direction \* TRAVEL_PX/);
  assert.match(variants, /x: direction \* -TRAVEL_PX \* 0\.6/);
  assert.doesNotMatch(jsx, /transformOrigin/, 'nothing left for an origin to anchor');
  assert.doesNotMatch(jsx, /isProject/, 'a project page rides the same transition as the rest');
});
