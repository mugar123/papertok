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
  assert.match(palette, /if \(open\) \{\s*reset\(\);\s*setLeavingBySelect\(false\);/);
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

/** Every innermost rule, comments left out: its selectors and its body. */
const rules = (source: string) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selectors, body]) => ({ selectors: selectors.trim().split(',').map(one => one.trim()), body }));

/** The bodies of every reduced-motion block, joined. */
const reducedMotion = (source: string) => [...source.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
  .map(match => match[1]).join('\n');

/**
 * 2026-10-18: the answer composes in the way a feed card does. One sequence
 * runs down the whole list rather than one per section: a section starts on
 * the step after the rows above it, and each row adds its place in it.
 */
test('the answer composes in once, in reading order', async () => {
  const palette = await read('./SearchCommand.tsx');
  assert.match(palette, /className="sc-group"\s*style=\{\{ '--sc-arrive': arrivesAt \}\}/);
  assert.match(palette, /arrivalStep \+= 1 \+ visibleRows\.length \+ \(showAll \? 1 : 0\);/);
  const css = await read('./SearchCommand.css');
  const arrival = rules(css).find(rule => rule.selectors.includes('.sc-group [cmdk-item]'));
  assert.ok(arrival, 'the rows have an arrival');
  assert.ok(arrival.selectors.includes('.sc-group [cmdk-group-heading]'), 'the headings arrive with them');
  const cap = arrival.body.match(/animation-delay: calc\(min\(var\(--sc-arrive, 0\) \+ var\(--sc-step, 0\), (\d+)\) \* \d+ms\);/);
  assert.ok(cap, 'a piece waits for its section\'s step plus its place in the section');
  // Every place up to the cap has its own step, and the rest share the last:
  // without the catch-all, rows past the seventh would arrive with the heading.
  const lastStep = Number(cap[1]);
  for (let place = 1; place < lastStep; place += 1) {
    assert.match(css, new RegExp(`\\.sc-group \\[cmdk-group-items\\] > :nth-child\\(${place}\\) \\{ --sc-step: ${place}; \\}`));
  }
  assert.match(css, new RegExp(`\\.sc-group \\[cmdk-group-items\\] > :nth-child\\(n \\+ ${lastStep}\\) \\{ --sc-step: ${lastStep}; \\}`));
  // A heading slides in from the side it reads from; a row rises.
  assert.match(css, /\.sc-group \[cmdk-group-heading\] \{\s*animation-name: scDevelop, scArriveAside;/);
  assert.match(css, /@keyframes scArriveAside \{\s*from \{\s*transform: translateX\(-\d+px\);/);
  assert.match(css, /@keyframes scArrive \{\s*from \{\s*transform: translateY\(\d+px\);/);
  // The wait itself arrives at rest: the entrance belongs to the answer.
  for (const selector of ['.sc-loading', '.sc-loading-heading', '.sc-skeleton-row']) {
    const rule = rules(css).find(one => one.selectors.includes(selector));
    assert.ok(rule, `${selector} is styled`);
    assert.doesNotMatch(rule.body, /animation|opacity/, `${selector} has no entrance of its own`);
  }
});

/**
 * The wait leaves in the frame the answer mounts. Fading up from zero left
 * the list blank for two frames between them (measured), so each piece holds
 * a faint first frame through its fill, never a static opacity.
 */
test('nothing in the answer starts from nothing, and reduced motion prints it whole', async () => {
  const css = await read('./SearchCommand.css');
  const develop = css.match(/@keyframes scDevelop \{\s*from \{\s*opacity: ([\d.]+);/);
  assert.ok(develop && Number(develop[1]) > 0, 'the answer develops from a faint first frame, not from zero');
  const animated = rules(css).filter(rule => /animation:[^;]*\bscDevelop\b/.test(rule.body));
  assert.ok(animated.length >= 2, 'the answer and its counts develop');
  for (const rule of animated) {
    // `backwards`: the first frame through the delay, nothing left after the
    // run, so a row's own opacity still holds once it has landed.
    assert.match(rule.body, /scDevelop \d+ms linear backwards/, 'opacity runs on a straight line and holds only its first frame');
    assert.doesNotMatch(rule.body, /\bboth\b|\bforwards\b/);
  }
  // No rule anywhere sets an opacity on a piece that arrives: one would hide
  // the answer outright under reduced motion, or after the run.
  const pieces = new Set(animated.flatMap(rule => rule.selectors));
  for (const rule of rules(css)) {
    if (rule.selectors.some(selector => pieces.has(selector))) {
      assert.doesNotMatch(rule.body, /opacity:/, `${rule.selectors.join(', ')} sets no opacity of its own`);
    }
  }
  const reduced = rules(reducedMotion(css)).filter(rule => /animation: none;/.test(rule.body));
  for (const selector of pieces) {
    assert.ok(reduced.some(rule => rule.selectors.includes(selector)), `${selector} keeps still under reduced motion`);
  }
});

test('on a wide screen the sheet follows its answer down, and only with motion', async () => {
  const css = await read('./SearchCommand.css');
  // Under reduced motion the list keeps its `auto` height: cmdk writes the
  // variable a frame after the content changes, so an untransitioned
  // explicit height would show one frame of the answer clipped to the wait.
  assert.match(css, /@media \(min-width: 641px\) and \(prefers-reduced-motion: no-preference\) \{\s*\.sc-sheet \[cmdk-list\] \{[^}]*height: min\(var\(--cmdk-list-height\), 60svh\);[^}]*transition: height \d+ms/);
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(code.match(/--cmdk-list-height/g)?.length, 1, 'the variable is read only inside that block');
  // The transition ends where the list's own clamp does.
  const command = await read('../ui/command.tsx');
  assert.match(command, /max-h-\[60svh\]/);
});
