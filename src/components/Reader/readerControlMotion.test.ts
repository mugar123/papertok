import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const POPOVER_JSX = new URL('../ui/popover.tsx', import.meta.url);

/** Comments name properties and durations in prose; matching them would invent both sides. */
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('a popover fades evenly and grows on its own curve', async () => {
  const popover = stripComments(await readFile(POPOVER_JSX, 'utf8'));
  const transition = popover.match(/\[transition:([^\]]+)\]/);
  assert.ok(transition, 'expected an explicit transition on the popup');
  // Two properties, two curves: the fade is a straight line and only the
  // travel gets the expo curve.
  assert.match(transition[1], /opacity_\d+ms_linear/);
  assert.match(transition[1], /scale_\d+ms_var\(--ease-out-expo\)/);
  // And it still starts from a box that exists: never `scale(0)`.
  const start = popover.match(/data-starting-style:scale-\[([\d.]+)\]/);
  assert.ok(start && Number(start[1]) >= 0.9, 'a popover must not grow out of nothing');
});
