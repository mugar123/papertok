/**
 * The palette on a phone (2026-09-22): the sheet is the screen, the rows are
 * two lines, and there is a way out that is neither a scrim nor a key.
 *
 * Pinned as source, the way paletteMotion.test.js pins the motion: the
 * behaviour lives in CSS and in the wiring between App, the palette and the
 * shared dialog, none of which a unit can render here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const css = await read('./SearchCommand.css');
const palette = await read('./SearchCommand.jsx');
const command = await read('../ui/command.jsx');
const app = await read('../../App.jsx');

/** The phone block: every `@media (max-width: 640px)` rule set, joined. */
const phone = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');

test('below 640px the sheet takes the whole viewport', () => {
  assert.ok(phone, 'there is a phone block');
  assert.match(phone, /\.sc-sheet \{[^}]*inset: 0;/);
  // The shared dialog centres with the `translate` property; without this the
  // full-width sheet sits half a screen to the left.
  assert.match(phone, /\.sc-sheet \{[^}]*translate: 0;/);
  assert.match(phone, /\.sc-sheet \{[^}]*height: 100dvh;/);
  assert.match(phone, /\.sc-sheet \{[^}]*border-radius: 0;/);
  // The list is the scroll container and gets everything under the field.
  assert.match(phone, /\.sc-sheet \[cmdk-list\] \{[^}]*max-height: none;/);
  assert.match(phone, /\.sc-sheet \[cmdk-list\] \{[^}]*flex: 1 1 auto;/);
});

test('rows are two lines at a finger\'s height, with the meta shown rather than hidden', () => {
  assert.match(phone, /\.sc-sheet \[cmdk-item\] \{[^}]*display: grid;/);
  assert.match(phone, /\.sc-sheet \[cmdk-item\] \{[^}]*min-height: 52px;/);
  // The utility `gap-3` sets both axes; an empty second track must cost nothing.
  assert.match(phone, /\.sc-sheet \[cmdk-item\] \{[^}]*row-gap: 0;/);
  assert.match(phone, /\.sc-sheet \[cmdk-item\] > \.sc-label \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(phone, /\.sc-sheet \[cmdk-item\] > \.sc-meta \{[^}]*grid-row: 2;/);
  // The old phone rule hid the year and the citations; nothing may bring it back.
  assert.doesNotMatch(phone, /\.sc-meta \{\s*display: none;/);
  assert.match(phone, /\.sc-skeleton-row \{[^}]*min-height: 52px;/);
});

test('Cancel exists on the phone and only there', () => {
  assert.match(css, /^\.sc-cancel \{\s*display: none;\s*\}/m);
  assert.match(phone, /\.sc-cancel \{[^}]*display: inline-flex;/);
  assert.match(phone, /\.sc-cancel \{[^}]*min-height: 44px;/);
  // A DialogClose rendered as the ui Button, inside the field's row.
  assert.match(palette, /<CommandInput[\s\S]*?<DialogClose\s+render=\{<Button variant="ghost" size="sm" className="sc-cancel" \/>\}/);
  assert.match(palette, /\{copy\.cancel\}/);
  assert.match(palette, /cancel: 'Cancelar',/);
  assert.match(palette, /cancel: 'Cancel',/);
  // cmdk answers Enter by picking the highlighted row; the button must keep it.
  assert.match(palette, /if \(event\.key === 'Enter'\) event\.stopPropagation\(\);/);
  assert.match(command, /\{children\}\s*<\/div>/, 'CommandInput renders its children after the field');
});

test('the phone sheet rises from below and reduced motion still switches it off', () => {
  assert.match(phone, /\.sc-sheet\[data-open\] \{\s*animation: scSheetInPhone/);
  assert.match(phone, /\.sc-sheet\[data-closed\] \{\s*animation: scSheetOutPhone [^;]*both;/);
  // The reduced-motion block names the same selectors and comes AFTER the
  // phone block, which is what lets it win at equal specificity.
  const phoneIndex = css.indexOf('scSheetInPhone');
  const reducedIndex = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(phoneIndex > 0 && reducedIndex > phoneIndex, 'reduced motion is declared after the phone motion');
  assert.match(css.slice(reducedIndex), /\.sc-sheet\[data-open\],\s*\.sc-sheet\[data-closed\],[\s\S]*?animation: none;/);
});

test('closing the palette gives the focus back to whoever opened it', () => {
  // No Base UI Trigger opens the palette, so the dialog is told where to
  // return: App records the opener and the palette hands it to the popup.
  assert.match(app, /const searchOpenerRef = useRef\(null\)/);
  assert.match(app, /searchOpenerRef\.current = document\.activeElement instanceof HTMLElement/);
  assert.match(app, /<SearchCommand open=\{searchOpen\} onOpenChange=\{setSearchOpen\} finalFocus=\{searchOpenerRef\} \/>/);
  assert.match(palette, /export default function SearchCommand\(\{ open, onOpenChange, finalFocus \}\)/);
  assert.match(palette, /<CommandDialog [^>]*finalFocus=\{finalFocus\}/);
  assert.match(command, /finalFocus=\{finalFocus\}/);
});
