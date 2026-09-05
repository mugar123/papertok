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
  assert.match(css, /\.sc-sheet\[data-open\] \{\s*animation: scSheetIn 380ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
  assert.match(css, /\.sc-sheet\[data-closed\] \{\s*animation: scSheetOut 220ms cubic-bezier\(0\.4, 0, 1, 1\) both;/);
});

test('the scrim is the palette\'s own, timed with the sheet', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-open\] \{\s*animation: fadeIn 380ms ease;/);
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-closed\] \{\s*animation: fadeOut 220ms ease both;/);
  // Anchored on the delimiter that must follow the selector inside the shared
  // rule — a comma when another selector follows (its case here), tightly
  // bound whitespace then `{animation: none;` when it is last in the list —
  // rather than an unconstrained scan. `.sc-scrim.sc-scrim[data-closed]` is
  // also its own always-on rule a few lines above this block (a different
  // declaration entirely); an unconstrained `[\s\S]*?` would walk straight
  // through that rule and on to this block's `animation: none;`, matching
  // even with the selector missing from the list below.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-scrim\.sc-scrim\[data-closed\](?:,[\s\S]*?|\s*\{\s*)animation: none;/);
  assert.ok(reduced, 'reduced motion drops the scrim fade as it drops the sheet\'s');
  const palette = await read('./SearchCommand.jsx');
  assert.match(palette, /<CommandDialog [^>]*overlayClassName=\{`sc-scrim\$\{leavingBySelect \? ' sc-scrim--select' : ''\}`\}/);
  const command = await read('../ui/command.jsx');
  assert.match(command, /function CommandDialog\(\{ children, className, overlayClassName, title = 'Search', \.\.\.props \}\)/);
  assert.match(command, /overlayClassName=\{overlayClassName\}/);
  const dialog = await read('../ui/dialog.jsx');
  assert.match(dialog, /<DialogOverlay className=\{overlayClassName\} \/>/);
});

/**
 * Picking a result is not dismissing the palette. Measured before this: the
 * sheet left on its 220ms ease-in with 14px of travel, the scrim on its own
 * 220ms `ease`, and the feed beneath on the page's 200ms exit — three
 * dissolves on three clocks, two empty frames at ~205ms, and the new page
 * arriving from the right under a 2% ghost of the sheet. When a row is
 * picked, sheet and scrim go in 100ms of opacity and the page transition is
 * the only movement left.
 */
test('a picked result closes the palette in 100ms of opacity, with no travel', async () => {
  const palette = await read('./SearchCommand.jsx');
  assert.match(palette, /const \[leavingBySelect, setLeavingBySelect\] = useState\(false\);/);
  assert.match(palette, /setLeavingBySelect\(true\);\s*onOpenChange\(false\);/);
  assert.match(palette, /if \(open\) \{\s*reset\(\);\s*setLeavingBySelect\(false\);\s*\}/);
  assert.match(palette, /className=\{`sc-sheet\$\{leavingBySelect \? ' sc-sheet--select' : ''\}`\}/);
  const css = await read('./SearchCommand.css');
  assert.match(css, /@keyframes scSheetGone \{\s*from \{\s*opacity: 1;\s*\}\s*to \{\s*opacity: 0;\s*\}\s*\}/);
  assert.match(css, /\.sc-sheet\.sc-sheet--select\[data-closed\] \{\s*animation: scSheetGone 100ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both;\s*\}/);
  assert.match(css, /\.sc-scrim\.sc-scrim\.sc-scrim--select\[data-closed\] \{\s*animation: fadeOut 100ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both;\s*\}/);
  // Reduced motion switches the picked exit off with the others.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-sheet\.sc-sheet--select\[data-closed\],[\s\S]*?animation: none;/);
  assert.ok(reduced, 'the picked exit is inside the reduced-motion list');
  // Same for the picked exit's scrim. It is last in the shared selector list,
  // so it is followed by `{` rather than a comma — the alternation covers
  // both shapes, and either way the declaration must follow with only
  // whitespace in between. `.sc-scrim.sc-scrim.sc-scrim--select[data-closed]`
  // is also its own always-on rule a few lines above this block, so a wider,
  // unconstrained scan would match through that rule too and prove nothing.
  const reducedScrim = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.sc-scrim\.sc-scrim\.sc-scrim--select\[data-closed\](?:,[\s\S]*?|\s*\{\s*)animation: none;/);
  assert.ok(reducedScrim, 'the picked exit\'s scrim is inside the reduced-motion list');
});
