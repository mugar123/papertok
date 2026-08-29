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
const READER_BAR_CSS = new URL('./ReaderBar.css', import.meta.url);
const READER_BAR_JSX = new URL('./ReaderBar.jsx', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

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
function atRuleBody(css, header, { contains } = {}) {
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
  assert.match(ruleBody(narrow, '.rd-panel-dock'), /bottom:\s*calc\(var\(--rd-sheet-peek-total\)/);
  assert.match(ruleBody(narrow, '.rd-scroll'), /padding-bottom:\s*calc\(var\(--rd-sheet-peek-total\)/);

  const narrowHover = atRuleBody(
    readerCss,
    '@media (max-width: 1100px) and (hover: hover) and (pointer: fine)'
  );
  assert.match(ruleBody(narrowHover, '.rd-scroll'), /padding-bottom:\s*calc\(var\(--rd-sheet-peek-total\)/);
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

/**
 * Task 4's own two facts, not the pre-existing `@media (max-width: 1100px)`
 * arithmetic the tests above hold — a coarse pointer never reaches that block
 * once this task's pairing (`(pointer: coarse) and (max-width: 1100px)`)
 * wins the cascade for it instead. Nothing above asserts either of these:
 * both were reasoned about in the report and neither was held to a test.
 *
 * The fix-wave review split what was one `(pointer: coarse) and
 * (max-width: 1100px)` block into two: the dock now hides on *any* coarse
 * pointer (an iPad in landscape is coarse but wider than 1100px, and used to
 * keep the dock underneath the bar — see PaperReader.css for the full
 * account), while the bar-height scroll padding stays narrow-scoped, because
 * the base 112px padding already clears the bar at that width. `contains`
 * disambiguates the dock lookup from the *other* bare `@media
 * (pointer: coarse)` block in this file (the kicker's, asserted below).
 */
test('the coarse-pointer bar clears the dock away, not the fine-pointer dock', async () => {
  const readerCss = await reader;
  const coarse = atRuleBody(readerCss, '@media (pointer: coarse)', { contains: '.rd-panel-dock' });
  assert.match(ruleBody(coarse, '.rd-panel-dock'), /display:\s*none/);

  const coarseNarrow = atRuleBody(readerCss, '@media (pointer: coarse) and (max-width: 1100px)');
  // Reads --rd-bar-h by name, the same token ReaderBar.css declares for
  // itself — a rule that quietly went back to a bare pixel figure here would
  // drift the moment someone retuned the bar's own height in the other file.
  assert.match(ruleBody(coarseNarrow, '.rd-scroll'), /padding-bottom:\s*calc\(var\(--rd-bar-h/);
  // And the dock rule itself no longer lives in this narrower block — it
  // widened to every coarse pointer above, not just this one.
  assert.doesNotMatch(coarseNarrow, /\.rd-panel-dock/);

  // The block this task's rule sits after and before is untouched — the same
  // dock-bottom and scroll-padding arithmetic the first test in this file
  // already holds the fine-pointer case to.
  const plainNarrow = atRuleBody(readerCss, '@media (max-width: 1100px)');
  assert.match(ruleBody(plainNarrow, '.rd-panel-dock'), /bottom:\s*calc\(var\(--rd-sheet-peek-total\)/);
});

test('ReaderBar.css never lets a rule stand outside (pointer: coarse)', async () => {
  const barCss = stripComments(await readFile(READER_BAR_CSS, 'utf8'));

  const mediaOpens = [...barCss.matchAll(/@media[^{]*\{/g)];
  assert.equal(mediaOpens.length, 1, 'ReaderBar.css should declare exactly one @media block');
  assert.match(mediaOpens[0][0], /\(pointer:\s*coarse\)/);

  // Brace-matched from that one opening, the same way `atRuleBody` reads a
  // block above — but here what matters is what is left *after* the closing
  // brace. A rule pasted below the block (or a second, narrower @media added
  // beside it later) would still leave `mediaOpens.length === 1` true; this
  // is the assertion that actually catches it.
  const openIndex = barCss.indexOf(mediaOpens[0][0]);
  const braceStart = barCss.indexOf('{', openIndex);
  let depth = 0;
  let closeIndex = -1;
  for (let i = braceStart; i < barCss.length; i += 1) {
    if (barCss[i] === '{') depth += 1;
    if (barCss[i] === '}') {
      depth -= 1;
      if (depth === 0) { closeIndex = i; break; }
    }
  }
  assert.notEqual(closeIndex, -1, 'unbalanced braces in ReaderBar.css');
  assert.equal(
    barCss.slice(0, openIndex).trim() + barCss.slice(closeIndex + 1).trim(),
    '',
    'a rule sits outside the (pointer: coarse) block in ReaderBar.css',
  );
});

/**
 * Task 7's own two facts, held the same way Task 4's dock-clearing test above
 * holds a CSS fact and the ReaderBar.css test above holds a pointer-gate: the
 * desktop selection path is what the whole redesign was forbidden from
 * touching, and the kicker's move into the document is new enough, and narrow
 * enough (one class, one JS condition), to be a single line nobody would
 * notice regress without a test naming it.
 */
test('el camino de escritorio sigue intacto: onMouseUp en el párrafo', async () => {
  const jsx = await readFile(READER_JSX, 'utf8');
  // Whitespace-tolerant on purpose: a reformat that wraps this prop onto its
  // own lines (Prettier does this once a line gets long enough) must not turn
  // this test red for a reason that has nothing to do with desktop selection
  // breaking. What has to hold is the fact, not the byte layout — `onMouseUp`
  // still wires straight to `handleSelection`, not through some other path.
  assert.match(jsx, /onMouseUp=\{\s*\(event\)\s*=>\s*handleSelection\(/);
});

test('el kicker que se muda al documento vive solo bajo pointer: coarse', async () => {
  const readerCss = await reader;
  // `contains` picks this block out from the *other* bare
  // `@media (pointer: coarse)` block in this file (the dock-hiding one the
  // test above holds) — without it, first-occurrence would happen to still
  // work today only because this one is declared first, which is exactly the
  // fragility `atRuleBody`'s doc comment warns about.
  const coarse = atRuleBody(readerCss, '@media (pointer: coarse)', { contains: '.rd-doc-kicker' });
  assert.match(ruleBody(coarse, '.rd-doc-kicker'), /display:\s*inline-flex/);

  // Belt-and-braces has to hold on both ends: the rule cannot also appear
  // reachable outside that one block (a copy-paste that landed both inside
  // and outside the query would still pass a test that only checked the
  // inside).
  const withoutCoarseBlock = readerCss.replace(coarse, '');
  assert.doesNotMatch(withoutCoarseBlock, /\.rd-doc-kicker\s*\{/);

  // And the element itself is never mounted for a fine pointer — the CSS
  // gate above is a second guarantee, not the only one.
  const jsx = await readFile(READER_JSX, 'utf8');
  assert.match(jsx, /\{coarsePointer && <span className="rd-doc-kicker">/);

  // The kicker's other half never renders for a coarse pointer either — if
  // it did, "Leer en simple" would print twice, once fixed and once in flow.
  assert.match(jsx, /\{!coarsePointer && <span className="rd-status-kicker">/);
});

test('el cromo superior se aparta con la barra, y un foco lo trae de vuelta', async () => {
  const readerCss = stripComments(await readFile(READER_CSS, 'utf8'));
  // La regla vive tras el gate de puntero grueso y sobre los HIJOS de los
  // wrappers (framer es dueño del transform inline del wrapper).
  assert.match(readerCss, /\.rd-float-close\[data-receded\]:not\(:has\(:focus-visible\)\) > \*/);
  assert.match(readerCss, /\.rd-status\[data-receded\]:not\(:has\(:focus-visible\)\) > \*/);
  const jsx = await readFile(READER_JSX, 'utf8');
  // Ambos wrappers cuelgan del mismo estado que la barra: si uno se queda
  // fuera, la mitad del cromo se queda plantada sobre el texto.
  assert.match(jsx, /className="rd-float-close" data-receded=\{chromeReceded/);
  assert.match(jsx, /className="rd-status" data-receded=\{chromeReceded/);
});

/**
 * El recorte del 2026-08-29: en móvil el lector es nivel + descarga, en una
 * isla que se esconde con el scroll. Estas guardas fijan la frontera — la
 * isla lleva exactamente los dos slots compartidos con el dock, y la ruta
 * táctil no monta ni raíl ni selección.
 */
test('la isla táctil lleva el nivel y la descarga, compartidos con el dock', async () => {
  const jsx = await readFile(READER_JSX, 'utf8');
  assert.match(jsx, /levelSlot=\{levelControl\}/);
  assert.match(jsx, /exportSlot=\{exportControl\}/);

  const barJsx = await readFile(READER_BAR_JSX, 'utf8');
  assert.match(barJsx, /\{levelSlot\}/);
  assert.match(barJsx, /\{exportSlot\}/);
  // Y nada de estados de selección: la isla tiene un solo estado.
  assert.doesNotMatch(barJsx, /'selection'|'composing'|tappedMark/);
});

test('la ruta táctil no monta el raíl de anotaciones ni la selección', async () => {
  const jsx = stripComments(await readFile(READER_JSX, 'utf8'));
  // El raíl cuelga de la ruta de menú (puntero fino): si este gate se cae,
  // el móvil recupera una hoja de anotaciones sin acciones que la alimenten.
  assert.match(jsx, /\{selectionRoute === 'menu' && \(\s*<AnnotationRail/);
  // Y el listener táctil de selectionchange no vuelve por otra puerta.
  assert.doesNotMatch(jsx, /useTouchSelection|selectionchange/);
});
