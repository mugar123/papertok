import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The Research filters on Base UI: the two folds are Collapsibles, the chips
 * are Toggles, the year rail is the ui Slider and the day step folds in place.
 * These pin what would compile without complaint if it regressed — a state
 * attribute written by hand next to the one the primitive writes, a fold with
 * no exit rule, a stylesheet still keyed on a class nothing sets any more.
 */

const read = (name) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

test('the filter block and its country section are Base UI Collapsibles; the trigger state is not written by hand', async () => {
  const jsx = await read('ReportFilters.jsx');
  const css = await read('ReportFilters.css');
  assert.match(jsx, /from '@base-ui\/react\/collapsible'/);
  assert.match(jsx, /<Collapsible\.Root className="rf" open=\{isOpen\} onOpenChange=\{handlePanelOpenChange\}>/);
  assert.match(jsx, /<Collapsible\.Trigger\s+render=\{<button type="button" className="rf-toggle" \/>\}/);
  assert.match(jsx, /<Collapsible\.Root\s+className="rf-section rf-section--country"\s+open=\{isCountryOpen\}/);
  assert.match(jsx, /<Collapsible\.Panel id=\{id\} className="rf-collapse">/);
  assert.doesNotMatch(jsx, /aria-expanded=|aria-controls=/, 'Base UI writes aria-expanded and aria-controls on the trigger; by hand they drift');
  assert.match(css, /\.rf-toggle\[data-panel-open\]/, 'the open look of the row reads the state Base UI writes');
  assert.doesNotMatch(css, /\.rf-toggle\.is-open/);
});

test('the fold is a CSS transition on the panel states, shorter on the way out and off under reduced motion', async () => {
  const css = await read('ReportFilters.css');
  assert.match(css, /\.rf-collapse \{[^}]*height: var\(--collapsible-panel-height\)/);
  assert.match(css, /\.rf-collapse\[data-starting-style\],\s*\.rf-collapse\[data-ending-style\] \{[^}]*height: 0/);
  assert.match(css, /\.rf-collapse\[data-ending-style\] \{[^}]*transition:/, 'closing has its own curve, eased at both ends');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.rf-collapse,\s*\.rf-collapse\[data-ending-style\] \{\s*transition: none/);
});

test('discipline chips are one multi-select ToggleGroup, quick countries are Toggles, and the pressed look reads data-pressed', async () => {
  const jsx = await read('ReportFilters.jsx');
  const css = await read('ReportFilters.css');
  assert.match(jsx, /<ToggleGroup\s+multiple[\s\S]*?value=\{activeCategories\}[\s\S]*?onValueChange=\{setCategories\}/);
  assert.match(jsx, /<Toggle\s+key=\{code\}[\s\S]*?pressed=\{activeCountries\.includes\(code\)\}[\s\S]*?onPressedChange=\{\(\) => toggleCountry\(code\)\}/);
  assert.doesNotMatch(jsx, /aria-pressed=/, 'the toggles write aria-pressed');
  assert.match(css, /\.rf-pill\[data-pressed\]/);
  assert.match(css, /\.rf-quick-country\[data-pressed\]/);
  assert.doesNotMatch(css, /\.rf-pill\.active|\.rf-quick-country\.selected/, 'a class nothing sets any more');
});

test('the country results keep their listbox semantics and the search field is the ui Input', async () => {
  const jsx = await read('ReportFilters.jsx');
  assert.match(jsx, /role="listbox"/);
  assert.match(jsx, /role="option"[\s\S]*?aria-selected=\{selected\}/);
  assert.match(jsx, /<Input\s+ref=\{countryInputRef\}[\s\S]*?type="search"[\s\S]*?aria-label=\{isEnglish \? 'Search affiliation country' : 'Buscar país de afiliación'\}/);
});

test('the year rail is the ui Slider, with both thumbs named in both languages; rc-slider is gone', async () => {
  const jsx = await read('CustomDateSelector.jsx');
  const css = await read('CustomDateSelector.css');
  assert.doesNotMatch(jsx, /rc-slider/);
  assert.doesNotMatch(css, /rc-slider/);
  assert.match(jsx, /from '\.\.\/ui\/slider\.jsx'/);
  assert.match(jsx, /<Slider[\s\S]*?value=\{yearRange\}[\s\S]*?onValueChange=\{handleYearRangeChange\}[\s\S]*?getAriaLabel=\{\(index\) => \(isEnglish \? \['Start year', 'End year'\] : \['Año inicial', 'Año final'\]\)\[index\]\}/);
  // Focus sits on the hidden input inside the thumb; the ring has to be drawn where it can be seen.
  assert.match(css, /\[data-slot='slider-thumb'\]:focus-within \{[^}]*outline: 2px solid var\(--focus-ring\)/);
});

test('step two folds in place as a Collapsible, not a popover, and without framer', async () => {
  const jsx = await read('CustomDateSelector.jsx');
  const css = await read('CustomDateSelector.css');
  assert.match(jsx, /<Collapsible\.Root\s+className="cds-step-two"\s+open=\{showCalendar\}/);
  assert.match(jsx, /<Collapsible\.Trigger render=\{<button type="button" className="cds-step cds-step--action" \/>\}>/);
  assert.match(jsx, /<Collapsible\.Panel className="cds-cal-slot">/);
  assert.doesNotMatch(jsx, /framer-motion|aria-expanded=/);
  assert.match(css, /\.cds-step--action\[data-panel-open\] \.cds-step-chevron/);
  assert.match(css, /\.cds-cal-slot \{[^}]*height: var\(--collapsible-panel-height\)/);
  assert.match(css, /\.cds-cal-slot\[data-starting-style\],\s*\.cds-cal-slot\[data-ending-style\] \{[^}]*height: 0/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(reduced && /\.cds-cal-slot/.test(reduced[1]), 'the fold is off under reduced motion');
  assert.doesNotMatch(css, /\.cds-btn/, 'the two actions are ui Buttons; the bespoke rules go with them');
});

test('a supported country on the map is a Base UI Toggle on its own path', async () => {
  const jsx = await read('WorldMap.jsx');
  const css = await read('WorldMap.css');
  assert.match(jsx, /from '@base-ui\/react\/toggle'/);
  assert.match(jsx, /<Toggle[\s\S]*?nativeButton=\{false\}[\s\S]*?pressed=\{isSelected\}[\s\S]*?onPressedChange=\{\(\) => onToggleCountry\(alpha2\)\}[\s\S]*?render=\{\(\s*<Geography/);
  assert.doesNotMatch(jsx, /aria-pressed=|role=\{|onKeyDown/, 'role, tab stop, Enter/Space and aria-pressed come from the primitive');
  assert.match(css, /\.wm-geo\[data-pressed\]/);
  assert.doesNotMatch(css, /\.wm-geo\.selected/);
});
