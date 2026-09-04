import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * Asked for on 2026-09-03: the palette arrived and left too quickly. Half as
 * long again on both, and the scrim on the same two clocks — the shared
 * overlay fades in 150ms, which a 220ms exit would outlive.
 */
test('the palette arrives in 380ms and leaves in 220ms', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-sheet\[data-state='open'\] \{\s*animation: scSheetIn 380ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
  assert.match(css, /\.sc-sheet\[data-state='closed'\] \{\s*animation: scSheetOut 220ms cubic-bezier\(0\.4, 0, 1, 1\) both;/);
});

test('the scrim is the palette\'s own, timed with the sheet', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-state='open'\] \{\s*animation: fadeIn 380ms ease;/);
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-state='closed'\] \{\s*animation: fadeOut 220ms ease both;/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-scrim\.sc-scrim\[data-state='closed'\] \{\s*animation: none;/);
  assert.ok(reduced, 'reduced motion drops the scrim fade as it drops the sheet\'s');
  const palette = await read('./SearchCommand.jsx');
  assert.match(palette, /<CommandDialog [^>]*overlayClassName="sc-scrim"/);
  const command = await read('../ui/command.jsx');
  assert.match(command, /function CommandDialog\(\{ children, className, overlayClassName, title = 'Search', \.\.\.props \}\)/);
  assert.match(command, /overlayClassName=\{overlayClassName\}/);
  const dialog = await read('../ui/dialog.jsx');
  assert.match(dialog, /<DialogOverlay className=\{overlayClassName\} \/>/);
});
