import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The margin of the reader has to scroll once its notes outgrow the screen
 * (reported 2026-09-24: "en la barra lateral de anotaciones no puedo hacer
 * scroll down", right after asking the AI to explain a passage).
 *
 * Measured in Chrome on the real reader, 1280×800, ten notes: the rail grew to
 * 2720px, `.rd-rail-list` was a scroll container with nothing to scroll
 * (scrollHeight = clientHeight = 2644px), and its `overscroll-behavior:
 * contain` kept the wheel from reaching the paper as well — a wheel over the
 * margin moved nothing at all. Capping the margin alone is not the fix either:
 * that was tried and reverted (4912b14, 570fa0c), and measured again it
 * crushed every card to fit the cap — the last from 145px to 38px, quote and
 * note cut off — because a note is `overflow: hidden` for its exit animation,
 * which takes away its automatic minimum height as a flex item, and the list
 * still had nothing to scroll.
 *
 * Source tests, the shape the reader already uses next door: the layout needs
 * a browser, and what is held here are the two declarations it turned on.
 */

const ANNOTATIONS_CSS = new URL('./Annotations.css', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first flat rule with exactly this selector. */
function ruleBody(css, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in Annotations.css`);
  return match[1];
}

const annotations = readFile(ANNOTATIONS_CSS, 'utf8').then(stripComments);

test('the margin is capped to the scroller, so a long list of notes has somewhere to scroll', async () => {
  const rail = ruleBody(await annotations, ".rd-rail[data-surface='rail']");
  assert.match(rail, /(?:^|[;\s])max-height:\s*100%\s*;/);
});

test('a note keeps its height in a capped column, so the list scrolls instead of crushing every card', async () => {
  const note = ruleBody(await annotations, '.rd-note');
  assert.match(note, /(?:^|[;\s])flex-shrink:\s*0\s*;/);
});
