import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The funding badge used to widen the whole sheet.
 *
 * The badge sits in a one-cell grid so its entrance can animate
 * `grid-template-rows` from `0fr` to `1fr`. That grid never declared a column,
 * and an implicit column is an `auto` track — which grows to its item's
 * content. So a funder with a long name ("Directorate for Mathematical &
 * Physical Sciences: …") sized the track past the sheet, and every
 * `max-width: 100%` below it — the motion wrapper's, the button's — resolved
 * against that inflated track instead of against the sheet. The button never
 * ran out of room, so the `text-overflow: ellipsis` on its label never fired;
 * the name was cut mid-word by `.pc-sheet`'s own `overflow-x: hidden`, and the
 * sheet, the body and the slot all reported ~100px of scrollable overflow they
 * had no way to reach.
 *
 * `min-width: 0` is the usual answer for a flex child that will not shrink
 * below its content, and the sheet is full of it. It is not the answer here:
 * the slot is not the box that grew, the grid track under it is, and only a
 * column sizing function can hold that. The rest of the chain was already
 * correct and is held below with it, because the fix is only worth as much as
 * the truncation it hands the work to.
 */

const FEED_CSS = new URL('./PaperCard.css', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one rule, by exact selector. */
function ruleBody(css, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in the stylesheet`);
  return match[1];
}

const feed = readFile(FEED_CSS, 'utf8').then(stripComments);

test('the funding badge slot pins its column to the sheet', async () => {
  const slot = ruleBody(await feed, '.pc-project-badge-slot');

  // `minmax(0, 1fr)` rather than `1fr`: an `fr` track floors at its item's
  // automatic minimum size, which is the un-wrapped badge, so `1fr` alone
  // grows exactly as far as the implicit `auto` track it replaces.
  assert.match(
    slot,
    /grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
    'the badge grid needs an explicit column that cannot exceed the sheet',
  );
});

test('the badge label still truncates once the slot holds it', async () => {
  const css = await feed;
  const label = ruleBody(css, '.pc-project-badge span');

  assert.match(label, /min-width:\s*0/, 'the label must be allowed to shrink inside the button');
  assert.match(label, /overflow:\s*hidden/);
  assert.match(label, /text-overflow:\s*ellipsis/, 'a clipped funder name reads as a rendering fault');
  assert.match(label, /white-space:\s*nowrap/);

  // The ellipsis only appears if the button itself stops at the slot.
  const button = ruleBody(css, '.pc-project-badge');
  assert.match(button, /max-width:\s*100%/);
  assert.match(button, /overflow:\s*hidden/);
});
