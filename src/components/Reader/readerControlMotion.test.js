import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PANEL_HIDE_DELAY_MS } from '../../utils/panelReveal.js';

/**
 * How the reader's three controls answer a pointer.
 *
 * All three were built once and never timed: the floating palette took almost
 * half a second to leave (a 300ms grace before a 180ms exit), the level chip
 * cross-faded between two buttons so nothing appeared to move at all, and the
 * download button walked through three states — "Download PDF", "Generating…",
 * "Downloaded" — as three hard cuts.
 *
 * Held in the shape `readerMobileStyles.test.js` next door uses: the component
 * mounts a portal over a streaming effect, so what is asserted here is the
 * wiring and the numbers, read out of the source. `PANEL_HIDE_DELAY_MS` is the
 * one value that already lives in a module of its own, so that one is imported
 * rather than read.
 */

const READER_JSX = new URL('./PaperReader.jsx', import.meta.url);
const READER_CSS = new URL('./PaperReader.css', import.meta.url);
const EXPORT_JSX = new URL('./ExportCard.jsx', import.meta.url);
const EXPORT_CSS = new URL('./Export.css', import.meta.url);
const POPOVER_JSX = new URL('../ui/popover.jsx', import.meta.url);

/** Comments name properties and durations in prose; matching them would invent both sides. */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const read = async url => stripComments(await readFile(url, 'utf8'));

/**
 * A brace-matched block, so an assertion cannot pass against the wrong one.
 *
 * `/const PANEL_STATES = \{[^}]+\}/` stops at the first inner brace — the end
 * of `shown`'s own transition — and every duration asserted from it would be
 * read out of a fragment that excludes the half this file cares about most.
 */
function block(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `expected to find \`${header}\``);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `expected a block after \`${header}\``);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new assert.AssertionError({ message: `unbalanced braces after \`${header}\`` });
}

/** Every `duration: 0.18` in a chunk of source, as milliseconds. */
const durationsMs = source => [...source.matchAll(/duration:\s*([\d.]+)/g)]
  .map(match => Math.round(Number(match[1]) * 1000));

test('the palette does not keep waiting after the pointer has gone', () => {
  // The grace exists so the boundary cannot flicker and so the trip down from
  // the text is not a race. The strip that summons it is 140px tall, which is
  // what lets this be short: a hand that wobbles off the edge is still inside
  // the zone, and never asks for the hide at all.
  assert.ok(
    PANEL_HIDE_DELAY_MS <= 160,
    `the grace before the palette leaves is ${PANEL_HIDE_DELAY_MS}ms, which reads as stuck`,
  );
  assert.ok(PANEL_HIDE_DELAY_MS > 0, 'no grace at all would flicker on the boundary');
});

test('the palette arrives and leaves inside a fifth of a second', async () => {
  const states = block(await read(READER_JSX), 'const PANEL_STATES');
  const shown = block(states, 'shown:');
  const hidden = block(states, 'hidden:');

  assert.ok(durationsMs(shown)[0] <= 220, `the palette takes ${durationsMs(shown)[0]}ms to arrive`);
  assert.ok(durationsMs(hidden)[0] <= 180, `the palette takes ${durationsMs(hidden)[0]}ms to leave`);
  // Shorter travel with the shorter duration: the same 12px in 160ms is a
  // faster-moving panel, which reads as brusque rather than as quick.
  assert.match(states, /y:\s*8\b/, 'expected the hidden state to sit 8px below');
  // An ease-in holds still at the exact moment the reader is looking at it.
  assert.doesNotMatch(states, /easeIn/, 'the exit must not start slow');
});

/**
 * Measured on the bench, both halves: with one expo-out curve driving the
 * whole state, the palette lost 56% of its opacity in the first 12ms and then
 * spent 100ms fading from nearly-invisible to invisible. That is a flash
 * followed by a smear, and it is what "not fluid" turned out to mean.
 */
test('the palette fades evenly, whatever its travel is doing', async () => {
  const states = block(await read(READER_JSX), 'const PANEL_STATES');
  for (const half of ['shown:', 'hidden:']) {
    const opacity = block(block(states, half), 'opacity:');
    assert.match(opacity, /ease:\s*'linear'/, `${half} must fade on a straight line`);
  }
});

test('the level chip is one element that travels, not two that cross-fade', async () => {
  const jsx = await read(READER_JSX);

  // A shared `layoutId` is what makes Motion move the old chip to the new one
  // rather than mount a second chip somewhere else.
  assert.match(jsx, /layoutId="rd-level-chip"/);
  assert.match(jsx, /className="rd-level-chip"/);

  const css = await read(READER_CSS);
  // The button must stop painting its own background, or the destination turns
  // yellow on the spot and there is nothing left for the chip to travel to.
  assert.match(css, /\.rd-level-item\[data-pressed\]\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /\.rd-level-chip\s*\{[^}]*position:\s*absolute/);
});

test('the palette and the phone bar do not share one chip', async () => {
  const jsx = await read(READER_JSX);
  // The dock is `display: none` on a touch screen but stays mounted, so both
  // surfaces hold the level control at once. One `layoutId` across the two
  // would fly the chip into a box that measures 0x0.
  const ids = [...jsx.matchAll(/<LayoutGroup id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2, 'expected the dock and the bar to each own a layout scope');
  assert.equal(new Set(ids).size, 2, 'the two surfaces must not share a layout id');
});

test('the download button gives under the press', async () => {
  const css = await read(EXPORT_CSS);
  const button = block(css, '.rd-export-go {');
  // The independent `scale` property, not a `transform: scale()`: the face
  // inside writes its own `transform` on every frame of a hand-over, and a
  // press written into that same property would be fighting it.
  assert.match(button, /transition:[^;]*\bscale\b/, 'the press has to be a transition, not a jump');
  assert.doesNotMatch(button, /transition:\s*all/, 'name the properties');

  const pressed = block(css, '.rd-export-go:not(:disabled):active');
  assert.match(pressed, /scale:\s*0\.9[5-8]/, 'expected a press of a few percent, not a collapse');

  // Reduced motion keeps the colour and drops the movement.
  const still = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(still, /\.rd-export-go\s*(,|\{)/);
});

test('the three states of the download button hand over', async () => {
  const jsx = await read(EXPORT_JSX);
  assert.match(jsx, /AnimatePresence/);
  // `mode="wait"` is what makes it a hand-over: the old label is gone before
  // the new one arrives, instead of the two crossing in the same 30px.
  assert.match(jsx, /<AnimatePresence[^>]*mode="wait"/);
  // One key per state, or there is nothing for the presence to notice.
  assert.match(jsx, /key=\{phase\}/);
  assert.match(jsx, /useReducedMotion/);
});

test('the download button is the width of its longest label, always', async () => {
  const jsx = await read(EXPORT_JSX);
  // The three labels are three widths (157px, 143px, 137px, measured), and a
  // button that resizes under its own label drags the card's whole foot with
  // it twice per download. The gauge holds all three stacked and invisible in
  // the cell the face animates in, so the box is sized by the longest.
  assert.match(jsx, /className="rd-export-go-gauge"/);
  assert.match(jsx, /copy\.generating, copy\.downloaded\]/);

  const css = await read(EXPORT_CSS);
  assert.match(block(css, '.rd-export-go {'), /display:\s*inline-grid/);
  assert.match(css, /\.rd-export-go-gauge\s*\{[^}]*visibility:\s*hidden/);
  // Both tenants in the same cell, or the gauge stacks above the face and the
  // button grows to twice its height. Matched on the rule, not on its
  // formatting: a reflow of this stylesheet must not read as a regression.
  const cell = css.match(/\.rd-export-go-gauge,\s*\.rd-export-go > \.rd-export-go-face\s*\{([^}]*)\}/);
  assert.ok(cell, 'expected the gauge and the face to share a rule');
  assert.match(cell[1], /grid-area:\s*1\s*\/\s*1/);
});

/**
 * The same flash, one component up: every popover in the app shares this
 * content wrapper, and it faded on the same expo-out curve — 0 → 0.53 in the
 * first 16ms of opening the export card, measured.
 */
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
