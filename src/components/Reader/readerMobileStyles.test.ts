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
 * feature elsewhere in this same file. So they are held here instead: read the
 * stylesheet, and assert the parts of the fix a stylesheet can be held to.
 */

const READER_CSS = new URL('./PaperReader.css', import.meta.url);
const ANNOTATIONS_CSS = new URL('./Annotations.css', import.meta.url);
const READER_JSX = new URL('./PaperReader.tsx', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of an at-rule, brace-matched.
 *
 * A media query here contains nested rules, so `/@media[^}]+}/` stops at the
 * first inner brace and every assertion built on it passes against nothing.
 *
 * `header` is matched as a *complete* at-rule prelude, not a prefix: plain
 * `indexOf(header)` would also match `@media (pointer: coarse)` inside
 * `@media (pointer: coarse) and (max-width: 1100px) { … }`, since the shorter
 * string is a literal prefix of the longer one — whichever came first in the
 * file, not necessarily the one the caller meant. Requiring the next
 * non-whitespace character after `header` to be `{` rules that out.
 *
 * A stylesheet can also legitimately declare the same *exact* header more
 * than once (this file has two bare `@media (pointer: coarse) { … }`
 * blocks). Plain first-occurrence would then depend on file order — a block
 * added above an existing one would silently retarget every caller of the
 * one below it. Pass `contains` (a substring expected somewhere in the
 * block's body) to pick the right one regardless of order; omitted, this
 * keeps the old first-occurrence behaviour for headers that are still unique.
 */
function atRuleBody(css: string, header: string, { contains }: { contains?: string } = {}) {
  let searchFrom = 0;
  while (searchFrom <= css.length) {
    const start = css.indexOf(header, searchFrom);
    assert.notEqual(
      start, -1,
      contains
        ? `expected to find \`${header}\` containing \`${contains}\` in the stylesheet`
        : `expected to find \`${header}\` in the stylesheet`,
    );
    let cursor = start + header.length;
    while (/\s/.test(css[cursor])) cursor += 1;
    if (css[cursor] !== '{') { searchFrom = cursor; continue; }
    const open = cursor;
    let depth = 0;
    let close = -1;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) throw new Error(`unbalanced braces after \`${header}\``);
    const body = css.slice(open + 1, close);
    if (!contains || body.includes(contains)) return body;
    searchFrom = close + 1;
  }
  throw new Error(`unbalanced braces after \`${header}\``);
}

/** The declarations of one rule inside a block, by exact selector. */
function ruleBody(block: string, selector: string) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = block.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in this block`);
  return match[1];
}

const reader = readFile(READER_CSS, 'utf8').then(stripComments);
const annotations = readFile(ANNOTATIONS_CSS, 'utf8').then(stripComments);

test('the sheet and the document read one peek', async () => {
  const [readerCss, annotationsCss] = await Promise.all([reader, annotations]);

  // Declared once, on the reader, so it is inherited rather than repeated. It
  // was private to `.rd-rail`, which is why the panel parked on top of it.
  const declarations = [...readerCss.matchAll(/--rd-sheet-peek:/g)].length
    + [...annotationsCss.matchAll(/--rd-sheet-peek:\s*\d/g)].length;
  assert.equal(declarations, 1, '--rd-sheet-peek should be declared exactly once');
  assert.match(ruleBody(readerCss, '.rd'), /--rd-sheet-peek:\s*32px/);

  // The sheet's real peeked top edge is --rd-sheet-peek plus the bottom
  // safe-area inset, not the bare constant — raising the sheet to clear the
  // home indicator moved it out from under whatever still measured from the
  // constant alone. Also declared exactly once, next to --rd-sheet-peek
  // itself, for the same reason the panel and the sheet share one number.
  const totalDeclarations = [...readerCss.matchAll(/--rd-sheet-peek-total:/g)].length
    + [...annotationsCss.matchAll(/--rd-sheet-peek-total:\s*\S/g)].length;
  assert.equal(totalDeclarations, 1, '--rd-sheet-peek-total should be declared exactly once');
  assert.match(
    ruleBody(readerCss, '.rd'),
    /--rd-sheet-peek-total:\s*calc\(var\(--rd-sheet-peek\)\s*\+\s*var\(--inset-bottom\)\)/
  );

  // And all four consumers actually read the derived token, not the bare
  // constant — a rule still measuring from --rd-sheet-peek alone clears less
  // than the sheet's real (inset-lifted) top edge on a device that has one.
  assert.match(annotationsCss, /translateY\(calc\(100% - var\(--rd-sheet-peek-total,/);

  const narrow = atRuleBody(readerCss, '@media (max-width: 1100px)');
  assert.match(
    ruleBody(narrow, ".rd-scroll:has(.rd-rail[data-surface='sheet']:not([data-hidden]))"),
    /padding-bottom:\s*calc\(var\(--rd-sheet-peek-total\)/,
  );
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
  // Scoped to `.rd-panel` (not bare `.rd-panel-group:first-child` /
  // `.rd-panel-divider`): the settings tab reuses this same JSX outside
  // `.rd-panel`, and a bare rule here made "Nivel", "Resaltados" and
  // "Descargar" invisible there too (`.rd-panel-label { display: none }`)
  // — see the fix-wave review, finding 3.
  assert.match(ruleBody(phone, '.rd-panel .rd-panel-group:first-child'), /grid-column:\s*1 \/ -1/);
  assert.match(ruleBody(phone, '.rd-panel .rd-panel-divider'), /display:\s*none/);

  // And the bare, unscoped selectors are gone — the point of the fix is that
  // they no longer exist inside this block to leak into the settings tab.
  assert.doesNotMatch(phone, /(?:^|[};])\s*\.rd-panel-group:first-child\s*\{/);
  assert.doesNotMatch(phone, /(?:^|[};])\s*\.rd-panel-label\s*\{/);
  assert.doesNotMatch(phone, /(?:^|[};])\s*\.rd-panel-divider\s*\{/);
});

test('the reader title is rendered like every other title in the app', async () => {
  const jsx = await readFile(READER_JSX, 'utf8');

  // It was the one printed raw, so a paper called "the $\mu$-Deformed Model"
  // arrived here still wearing its dollars.
  assert.match(jsx, /import ScientificText from '\.\.\/ScientificText\.ts';/);
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

/**
 * Task 7's own two facts, held the same way Task 4's dock-clearing test above
 * holds a CSS fact and the ReaderBar.css test above holds a pointer-gate: the
 * desktop selection path is what the whole redesign was forbidden from
 * touching, and the kicker's move into the document is new enough, and narrow
 * enough (one class, one JS condition), to be a single line nobody would
 * notice regress without a test naming it.
 */
test('el camino de escritorio sigue intacto: el mouse-up del documento llama a handleSelection', async () => {
  const jsx = await readFile(READER_JSX, 'utf8');
  // The desktop route is a mouse-up wired straight to `handleSelection`. It
  // lived on each paragraph until 2026-09-17, when a release outside the
  // paragraph — the gap, the margin, the heading — turned out to reach no
  // handler at all; it is one document listener now, and the paragraph is
  // read off the selection (readerMouseSelection.test.ts holds the shape).
  // What has to hold here is the fact, not the byte layout: the mouse-up
  // still hands the selection to `handleSelection`, not to some other path.
  assert.match(jsx, /document\.addEventListener\('mouseup', handleDocumentMouseUp\)/);
  assert.match(jsx, /handleSelection\(sectionId, paragraphIndex, text, paragraph, /);
  assert.doesNotMatch(jsx, /onMouseUp=\{\s*\(event\)\s*=>\s*handleSelection\(/);
});
