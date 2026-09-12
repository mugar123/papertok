import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The three things that happen when you select a passage, and the one that
 * happens when you open the export card.
 *
 * All four were found by audit on 2026-09-12, and three of them are the same
 * shape of defect: an animation that still exists in the stylesheet but that
 * nobody can see. The menu grew into the note composer with nothing animating
 * the change of size; it faded in on a curve that was 79% done in 60ms; and
 * the flag that keeps the pen stroke on a freshly marked passage was taken off
 * at 220ms, less than half way through the 420ms stroke it exists for.
 *
 * Source tests, the shape the reader already uses next door
 * (`readerMobileStyles`, `readerControlMotion`): a popup anchored to a live
 * text selection is not something a harness mounts, so what is held here is the
 * wiring and the numbers.
 */

const ANNOTATIONS_CSS = new URL('./Annotations.css', import.meta.url);
const EXPORT_CSS = new URL('./Export.css', import.meta.url);
const RAIL_JSX = new URL('./AnnotationRail.jsx', import.meta.url);
const POPOVER_JSX = new URL('../ui/popover.jsx', import.meta.url);
const HOOK = new URL('../../hooks/usePassageAnnotations.js', import.meta.url);

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const read = async url => stripComments(await readFile(url, 'utf8'));

/** The body of `selector { … }`, matched on the rule rather than on its formatting. */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a \`${selector}\` rule`);
  return match[1];
}

test('the selection menu grows into the composer instead of jumping', async () => {
  const css = await read(ANNOTATIONS_CSS);
  const menu = rule(css, '.rd-menu');
  // The two widths are declared — 244px for the three choices, 348px for the
  // composer — so the box only needs the property named in its transition.
  assert.match(css, /\.rd-menu\[data-composing\]\s*\{[^}]*width:/);
  assert.match(menu, /transition:[^;]*\bwidth\b/, 'the width has to travel');
});

test('the selection menu fades evenly, like every other surface in the reader', async () => {
  const menu = rule(await read(ANNOTATIONS_CSS), '.rd-menu');
  assert.match(menu, /opacity\s+\d+ms\s+linear/, 'the fade must be a straight line');
  // And it still arrives from somewhere: opacity alone is a light switch.
  const css = await read(ANNOTATIONS_CSS);
  assert.match(css, /\.rd-menu\[data-starting-style\]\s*\{[^}]*translate:/);
});

/**
 * `fresh` is one flag holding two animations, and the rail used to drop it the
 * moment its own card had finished arriving — 220ms — which cut the pen stroke
 * on the passage (420ms) and the writing of an AI note (620ms) mid-sweep.
 */
test('the fresh flag outlives the longest animation it holds', async () => {
  const hook = await read(HOOK);
  const declared = hook.match(/FRESH_SETTLE_MS\s*=\s*([\d_]+)/);
  assert.ok(declared, 'expected the hook to own the settle delay');
  const settle = Number(declared[1].replace(/_/g, ''));

  const css = await read(ANNOTATIONS_CSS);
  const durations = [...css.matchAll(/animation:\s*(rdPenDown|rdWriteIn)\s+(\d+)ms/g)]
    .map(match => Number(match[2]));
  assert.ok(durations.length >= 2, 'expected both fresh-driven animations');
  const longest = Math.max(...durations);
  assert.ok(
    settle > longest,
    `the flag comes off at ${settle}ms, before the ${longest}ms animation it exists for`,
  );
});

test('the rail no longer decides when the pen stroke is over', async () => {
  const rail = await read(RAIL_JSX);
  // Its card arrives in 220ms. Whatever it does on completion, it must not be
  // taking a flag off two other animations that are still running.
  assert.doesNotMatch(rail, /onAnimationComplete=\{\(\) => \{ if \(annotation\.fresh\) onSettle/);
});

/** How deep in `{ … }` a selector sits: 0 is the top level. */
function nestingDepth(css, needle) {
  const at = css.indexOf(needle);
  assert.notEqual(at, -1, `expected to find \`${needle}\``);
  const before = css.slice(0, at);
  return (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
}

test('the export card arrives from below again', async () => {
  const css = await read(EXPORT_CSS);
  assert.match(css, /\.rd-export\[data-starting-style\]\s*\{[^}]*translate:\s*0\s+\d+px/);
  // At the top level, and not swallowed by the button's block above it: as a
  // nested rule it reads as `.rd-export-go .rd-export[…]`, which matches
  // nothing — the shape this exact rule shipped in for one round, invisible to
  // a test that only looked for the text (2026-09-12).
  assert.equal(nestingDepth(css, '.rd-export[data-starting-style]'), 0);
  assert.equal(nestingDepth(css, '.rd-export[data-ending-style]'), 0);
  // The shared popover has to list the property, or the value above is a jump.
  const popover = await read(POPOVER_JSX);
  const transition = popover.match(/\[transition:([^\]]+)\]/);
  assert.ok(transition, 'expected an explicit transition on the popup');
  assert.match(transition[1], /translate_\d+ms/);
});
