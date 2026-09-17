import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

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
