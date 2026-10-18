import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * 2026-10-15: the palette is opened from the keyboard many times a day, so it
 * arrives and leaves in 150ms on an ease-out, the exit opacity only — no
 * ease-in. The scrim keeps the same clocks.
 */
test('the palette arrives and leaves in 150ms on an ease-out', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-sheet\[data-open\] \{\s*animation: scSheetIn 150ms var\(--ease-out\);/);
  assert.match(css, /\.sc-sheet\[data-closed\] \{\s*animation: scSheetGone 150ms var\(--ease-out\) both;/);
  assert.doesNotMatch(css, /cubic-bezier\(0\.4, 0, 1, 1\)/);
  const palette = await read('./SearchCommand.tsx');
  assert.doesNotMatch(palette, /wrapperClassName="sc-enter"/, 'the field does not move on open');
});

test('the scrim is the palette\'s own, timed with the sheet', async () => {
  const css = await read('./SearchCommand.css');
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-open\] \{\s*animation: fadeIn 150ms var\(--ease-out\);/);
  assert.match(css, /\.sc-scrim\.sc-scrim\[data-closed\] \{\s*animation: fadeOut 150ms var\(--ease-out\) both;/);
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
  const palette = await read('./SearchCommand.tsx');
  assert.match(palette, /<CommandDialog [^>]*overlayClassName=\{`sc-scrim\$\{leavingBySelect \? ' sc-scrim--select' : ''\}`\}/);
  const command = await read('../ui/command.tsx');
  assert.match(command, /function CommandDialog\(\{ children, className, overlayClassName, finalFocus, commandProps, title = 'Search', \.\.\.props \}: Omit<ComponentProps<typeof Dialog>, 'children'> & \{ children\?: ReactNode \} & Pick<ComponentProps<typeof DialogContent>, 'className' \| 'overlayClassName' \| 'finalFocus'> & \{ title\?: string; commandProps\?: ComponentProps<typeof Command> \}\)/);
  assert.match(command, /overlayClassName=\{overlayClassName\}/);
  const dialog = await read('../ui/dialog.tsx');
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
  const palette = await read('./SearchCommand.tsx');
  assert.match(palette, /const \[leavingBySelect, setLeavingBySelect\] = useState(?:<[^;\n]+>)?\(false\);/);
  assert.match(palette, /setLeavingBySelect\(true\);\s*onOpenChange\(false\);/);
  assert.match(palette, /if \(open\) \{\s*reset\(\);\s*setLeavingBySelect\(false\);\s*setCascadeDone\(false\);/);
  assert.match(palette, /className=\{`sc-sheet\$\{leavingBySelect \? ' sc-sheet--select' : ''\}`\}/);
  const css = await read('./SearchCommand.css');
  assert.match(css, /@keyframes scSheetGone \{\s*from \{\s*opacity: 1;\s*\}\s*to \{\s*opacity: 0;\s*\}\s*\}/);
  assert.match(css, /\.sc-sheet\.sc-sheet--select\[data-closed\] \{\s*animation: scSheetGone 100ms var\(--ease-out\) both;\s*\}/);
  assert.match(css, /\.sc-scrim\.sc-scrim\.sc-scrim--select\[data-closed\] \{\s*animation: fadeOut 100ms var\(--ease-out\) both;\s*\}/);
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

/**
 * 2026-10-17: the rows cascade in for the first answer after opening only.
 * Typing is a keyboard action repeated all day; rows that arrive behind it are
 * simply there. The cascade is switched off only after it has finished, and
 * re-armed on the way in.
 */
test('the results cascade once per opening, not on every keystroke', async () => {
  const palette = await read('./SearchCommand.tsx');
  assert.match(palette, /setTimeout\(\(\) => setCascadeDone\(true\), ENTER_STAGGER_CAP \* ENTER_STEP_MS \+ ENTER_RISE_MS\)/);
  assert.match(palette, /const rows = still \? visibleRows : Children\.map/);
  assert.match(palette, /className=\{still \? 'sc-heading' : 'sc-heading sc-enter'\}/);
  const css = await read('./SearchCommand.css');
  assert.match(css, /animation: scEnterRise 260ms var\(--ease-out-expo\) forwards;\s*animation-delay: calc\(var\(--sc-enter-index, 0\) \* 24ms\);/, 'the clock the timer mirrors');
});

/**
 * 2026-10-18: sources answer one by one. A section that lands after the
 * answer's first paint answers no keystroke, so it enters even once the
 * cascade is off; and each section counts its cascade from its own heading,
 * so one inserted above another cannot renumber rows already arriving.
 */
test('a late section enters on its own cascade', async () => {
  const palette = await read('./SearchCommand.tsx');
  assert.match(palette, /const still = cascadeDone && firstPaint\.sections\.includes\(section\);/);
  assert.match(palette, /'--sc-enter-index': Math\.min\(offset \+ 1, ENTER_STAGGER_CAP\)/);
  assert.doesNotMatch(palette, /enterIndex/, 'no index counted down the whole list');
});
