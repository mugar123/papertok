import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * WCAG 2.2 SC 2.5.8 (Target Size Minimum).
 *
 * The annotation rail's filter chips (`.rd-rail-filter`) draw at
 * `padding: 4px 8px` on a 1-line-height 10px mono font -- about 20px tall,
 * measured. With a `gap: 4px` between them that is still comfortably wide
 * (the three current labels, in both languages, land 40px+ apart centre to
 * centre) for the Spacing exception to save the row from itself today, but
 * that depends on exactly how long "Todas"/"Tuyas"/"IA" happen to be and on
 * nothing else ever sitting closer -- a fourth filter, a longer translation,
 * either one tightens it. The floor is the size route instead: a fixed
 * 24px hit area that does not depend on current label widths, using the
 * same out-of-flow `::after` technique `ThemeToggle.css` already uses to
 * grow a drawn 32px control to a 44px touch area without moving it.
 *
 * This is a source-parse, not a geometry unit test, because there is no
 * layout function here to call -- Annotations.css is the whole fix.
 */

const ANNOTATIONS_CSS = new URL('./Annotations.css', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one flat (non-nested) rule, by exact selector. */
function ruleBody(css, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in Annotations.css`);
  return match[1];
}

const annotations = readFile(ANNOTATIONS_CSS, 'utf8').then(stripComments);

test('the filter chip is a positioning context for its own hit-area pseudo-element', async () => {
  const css = await annotations;
  assert.match(ruleBody(css, '.rd-rail-filter'), /position:\s*relative/);
});

test('the drawn chip keeps its own compact padding -- only the hit area grows', async () => {
  const css = await annotations;
  assert.match(ruleBody(css, '.rd-rail-filter'), /padding:\s*4px 8px/);
});

test('the filter chip\'s hit area clears the 24px floor without reaching a neighbour', async () => {
  const css = await annotations;
  const after = ruleBody(css, '.rd-rail-filter::after');
  assert.match(after, /position:\s*absolute/);
  assert.match(after, /height:\s*24px/);
  // Only the height grows. `left`/`right` pin the pseudo-element to the
  // button's own width instead of centring a fixed width on it, so the 4px
  // gap between two filters can never become an overlap between their hit
  // areas -- the trap this same effort already hit once, from the opposite
  // direction (a pseudo-element wide enough to reach a sibling control).
  assert.match(after, /left:\s*0/);
  assert.match(after, /right:\s*0/);
  assert.doesNotMatch(after, /width:/);
});
