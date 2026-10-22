import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * SOURCE test for where the sheet sits in a card taller than it.
 *
 * The sheet is capped twice: at the card's height (`max-height: 100%`) and,
 * through the abstract, at 30em of body text. On a laptop the two caps meet
 * and the sheet fills the card, so its alignment never showed. On a tall
 * screen the abstract's cap wins and the sheet is shorter than the card, and
 * `align-items: flex-end` on the card put it at the foot with the top half of
 * the screen empty. Measured 2026-09-17 on a 2000×1462 viewport (production
 * build, guest feed): a 743px sheet at 679–1422 under 620px of nothing, the
 * title 780px down, the action rail centred on 759 with nothing beside it.
 * Centred, the sheet shares the rail's middle at every height; at 1440×900
 * the sheet is at its cap and nothing moves.
 *
 * Bottom-justification stays INSIDE the sheet: when the card is short it is
 * the abstract that yields (from the top of its box), never the actions.
 */
test('the sheet is centred in a card taller than it, and bottom-justified within', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  const card = css.match(/\n\.pc \{([^}]*)\}/)?.[1] || '';
  assert.match(card, /align-items: center;/, 'the card centres its sheet and its rail');
  assert.doesNotMatch(card, /align-items: flex-end;/);
  const sheet = css.match(/\n\.pc-sheet \{([^}]*)\}/)?.[1] || '';
  assert.match(sheet, /max-height: 100%;/, 'the sheet still cannot outgrow the card');
  assert.match(sheet, /justify-content: flex-end;/, 'and its column still sits on its foot');
  // The rail already centred itself; the two must agree.
  const rail = css.match(/\n\.pc-side-actions \{\s*position: relative;([^}]*)\}/)?.[1] || '';
  assert.match(rail, /align-self: center;/);
});

/**
 * SOURCE test for a short window with the graph open. The inline graph only
 * gets what the rows above it leave: at 1280×600 that was 89px, its header
 * and a sliver of map. While it is open the paper above it steps back on a
 * short window, and the action row never does. Similar papers scroll inside
 * the slot and leave the paper as it is.
 */
test('on a short window the paper above the graph yields, the actions stay', async () => {
  const jsx = await read('./PaperCard.tsx');
  assert.match(jsx, /className="pc-sheet" data-connections=\{relatedInline \|\| undefined\}/);

  const css = stripComments(await read('./PaperCard.css'));
  const start = css.indexOf('@media (max-height: 760px) {\n  .pc-sheet[data-connections]');
  assert.ok(start >= 0, 'a short-window block keyed to the open connections');
  const block = css.slice(start, css.indexOf('\n}\n', start));
  assert.match(block, /\.pc-title \{\s*-webkit-line-clamp: 2;/);
  assert.doesNotMatch(block, /\.pc-action-bar \{[^}]*display: none/, 'the actions are never what yields');
  assert.doesNotMatch(block, /\.pc-(meta|authors|chips) \{[^}]*display: none/, 'the kicker, the authors and the status chips stay');
});

/**
 * SOURCE test for the two reading actions staying put. The Read label can
 * change after a card is shown and "Read in plain words" can arrive with a
 * free copy, so each action has its own slot and no slot depends on the
 * other's width. The row does not rise with the card's arrival either.
 */
test('the reading actions sit in two fixed slots and do not arrive with the card', async () => {
  const css = stripComments(await read('./PaperCard.css'));

  const row = css.match(/\n\.pc-action-primary \{([^}]*)\}/)?.[1] || '';
  assert.match(row, /display: grid;/);
  assert.match(row, /grid-template-columns: repeat\(2, minmax\(0, [^)]+\)\);/);
  assert.doesNotMatch(row, /flex-wrap/, 'a long label never pushes the other action onto a new line');

  const phone = css.slice(css.indexOf('@media (max-width: 640px) {'));
  assert.match(phone, /\.pc-action-primary \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);

  const arriving = css.match(/([^{}]*)\{\s*animation: appear /)?.[1] || '';
  assert.ok(arriving.includes('.pc-abstract'), 'the arrival rule is the one found');
  assert.ok(!arriving.includes('.pc-action-bar'), 'the action row is in place from the first frame');

  const jsx = await read('./PaperCard.tsx');
  assert.doesNotMatch(jsx, /animateSize\(button, 'width'/, 'the Read button no longer changes width');
});
