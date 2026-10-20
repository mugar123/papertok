import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { FileHandle } from 'fs/promises';

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
const RAIL_JSX = new URL('./AnnotationRail.tsx', import.meta.url);
const HOOK = new URL('../../hooks/usePassageAnnotations.ts', import.meta.url);

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const read = async (url: string|URL|Buffer<ArrayBufferLike>|FileHandle) => stripComments(await readFile(url, 'utf8'));

/** The body of `selector { … }`, matched on the rule rather than on its formatting. */
function rule(css: string, selector: string) {
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


test('the rail slides on valid transitions, and no stylesheet gives a duration token a second curve', async () => {
  const css = stripComments(await read(ANNOTATIONS_CSS));
  const rail = css.match(/\.rd-rail\[data-surface='rail'\] \{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(rail, /margin-right \d/, 'the paper column snaps; only the rail moves');
  assert.match(rail, /transform 240ms var\(--ease-out-quad\)/);
  assert.match(rail, /visibility 0s/);
  const hidden = css.match(/\.rd-rail\[data-surface='rail'\]\[data-hidden\] \{([^}]*)\}/)?.[1] || '';
  assert.match(hidden, /transition-delay: 0s, 0s, 240ms;/, 'visibility waits for the slide, with a plain delay');
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.rd-rail\[data-surface='sheet'\],\s*\.rd-rail\[data-surface='rail'\],/);
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const full = join(dir, name); return statSync(full).isDirectory() ? walk(full) : full.endsWith('.css') ? [full] : []; });
  for (const file of walk(root)) {
    const source = stripComments(await readFile(file, 'utf8'));
    assert.doesNotMatch(source, /var\(--transition-(?:fast|base|slow|spring)\)\s+(?:cubic-bezier|ease|linear|steps)/, `${file}: a transition token already carries its curve`);
  }
});

/**
 * The export card closed on the arrival's curve: 5.1 of its 6px in the first
 * two frames, then 90ms of a card fading in place (measured 2026-09-18). A
 * departure brakes where nobody is looking, so it goes back down into the
 * button on the quad, 10px over 200ms, with the fade a straight line.
 */
