import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * What a phone did to the reader's chrome.
 *
 * Three of these are the same mistake in three places: a control laid out
 * against a number somebody guessed, on a screen narrow enough for the guess to
 * be wrong. The status line reserved 140px for a 40px button and its kicker
 * wrapped onto the paper's title; the control panel asked for about 420px of a
 * 340px row and answered the difference with a hidden horizontal scroll, so the
 * third reading level sat underneath the highlighter; and the panel and the
 * annotation sheet both measured up from `bottom: 0` without either knowing the
 * other was there.
 *
 * None of the three produced a warning, a lint error or a failing build — an
 * overflowing flex row is valid CSS and a hidden scrollbar is a deliberate
 * feature elsewhere in this same file. So they are held here instead, in the
 * shape `publicProfileStyles.test.js` uses one screen over: read the stylesheet,
 * and assert the parts of the fix a stylesheet can be held to.
 */

const READER_CSS = new URL('./PaperReader.css', import.meta.url);
const ANNOTATIONS_CSS = new URL('./Annotations.css', import.meta.url);
const READER_JSX = new URL('./PaperReader.jsx', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of an at-rule, brace-matched.
 *
 * A media query here contains nested rules, so `/@media[^}]+}/` stops at the
 * first inner brace and every assertion built on it passes against nothing.
 */
function atRuleBody(css, header) {
  const start = css.indexOf(header);
  assert.notEqual(start, -1, `expected to find \`${header}\` in the stylesheet`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after \`${header}\``);
}

/** The declarations of one rule inside a block, by exact selector. */
function ruleBody(block, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = block.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in this block`);
  return match[1];
}

const reader = readFile(READER_CSS, 'utf8').then(stripComments);
const annotations = readFile(ANNOTATIONS_CSS, 'utf8').then(stripComments);

test('the sheet, the panel and the document read one peek', async () => {
  const [readerCss, annotationsCss] = await Promise.all([reader, annotations]);

  // Declared once, on the reader, so it is inherited rather than repeated. It
  // was private to `.rd-rail`, which is why the panel parked on top of it.
  const declarations = [...readerCss.matchAll(/--rd-sheet-peek:/g)].length
    + [...annotationsCss.matchAll(/--rd-sheet-peek:\s*\d/g)].length;
  assert.equal(declarations, 1, '--rd-sheet-peek should be declared exactly once');
  assert.match(ruleBody(readerCss, '.rd'), /--rd-sheet-peek:\s*62px/);

  // And all three consumers actually read it.
  assert.match(annotationsCss, /translateY\(calc\(100% - var\(--rd-sheet-peek/);

  const narrow = atRuleBody(readerCss, '@media (max-width: 1100px)');
  assert.match(ruleBody(narrow, '.rd-panel-dock'), /bottom:\s*calc\(var\(--rd-sheet-peek\)/);
  assert.match(ruleBody(narrow, '.rd-scroll'), /padding-bottom:\s*calc\(var\(--rd-sheet-peek\)/);
});

test('the foot of the document is set in one file', async () => {
  const annotationsCss = await annotations;

  // `Annotations.css` loads second, so a `padding-bottom` here silently outranked
  // the phone rule in `PaperReader.css` — two files, neither readable alone.
  const rules = [...annotationsCss.matchAll(/\.rd-scroll\s*\{([^}]*)\}/g)];
  for (const [, body] of rules) {
    assert.doesNotMatch(body, /padding-bottom/, '.rd-scroll padding-bottom belongs in PaperReader.css');
  }
});

test('the panel stacks on a phone instead of scrolling out of sight', async () => {
  const phone = atRuleBody(await reader, '@media (max-width: 640px)');
  const panel = ruleBody(phone, '.rd-panel');

  assert.match(panel, /display:\s*grid/);
  assert.match(panel, /grid-template-columns:\s*repeat\(3,\s*1fr\)/);

  // The bug itself: `overflow-x: auto` with `scrollbar-width: none` inherited
  // from the base rule turned "does not fit" into "looks broken".
  assert.match(panel, /overflow-x:\s*visible/);
  assert.doesNotMatch(panel, /overflow-x:\s*auto/);

  // The level names take the first row whole; the actions fall into the second.
  assert.match(ruleBody(phone, '.rd-panel-group:first-child'), /grid-column:\s*1 \/ -1/);
  assert.match(ruleBody(phone, '.rd-panel-divider'), /display:\s*none/);
});

test('the status line is anchored, not allowanced', async () => {
  const phone = atRuleBody(await reader, '@media (max-width: 640px)');
  const status = ruleBody(phone, '.rd-status');

  // `max-width: calc(100% - 140px)` left the kicker 250px of a 390px screen and
  // it wrapped onto the title. The left edge now names what it clears.
  assert.match(status, /max-width:\s*none/);
  assert.match(status, /left:\s*calc\(var\(--space-4\) \+ 40px/);
  assert.doesNotMatch(phone, /calc\(100% - 140px\)/);

  // It gives way by being cut, not by growing a second line.
  assert.match(ruleBody(phone, '.rd-status-kicker'), /white-space:\s*nowrap/);
});

test('the document clears the back button on a phone with a notch', async () => {
  const phone = atRuleBody(await reader, '@media (max-width: 640px)');
  const scroll = ruleBody(phone, '.rd-scroll');

  // The chrome moves down with the inset and a flat 56px did not, so the title's
  // first line went under the button on every phone that has one.
  assert.match(scroll, /padding-top:\s*calc\(max\(var\(--space-4\), env\(safe-area-inset-top\)\)/);
});

test('the reader title is rendered like every other title in the app', async () => {
  const jsx = await readFile(READER_JSX, 'utf8');

  // It was the one printed raw, so a paper called "the $\mu$-Deformed Model"
  // arrived here still wearing its dollars.
  assert.match(jsx, /import ScientificText from '\.\.\/ScientificText\.js';/);
  assert.match(jsx, /<h1 className="rd-doc-title" lang="en"><ScientificText>\{paper\?\.title\}<\/ScientificText><\/h1>/);
});

test('the loading ghost fills a phone and leaves the desktop alone', async () => {
  const readerCss = await reader;
  const phone = atRuleBody(readerCss, '@media (max-width: 640px)');

  // Drawn for every screen, shown only where there is height to fill.
  assert.match(readerCss, /\.rd-ghost-lines i:nth-child\(n \+ 6\)\s*\{\s*display:\s*none/);
  assert.match(phone, /\.rd-ghost-lines i:nth-child\(n \+ 6\)\s*\{\s*display:\s*block/);

  // The rule is worth nothing if the JSX stopped drawing a sixth line.
  const jsx = await readFile(READER_JSX, 'utf8');
  const ghost = jsx.match(/const GHOST_LINES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(ghost, 'expected a GHOST_LINES array');
  const widths = [...ghost[1].matchAll(/'(\d+%)'/g)];
  assert.ok(widths.length >= 6, `GHOST_LINES should carry a tail past the fifth line, got ${widths.length}`);
});
