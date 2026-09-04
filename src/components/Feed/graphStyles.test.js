import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The citation map is drawn from computed positions, so almost every element
 * it renders is a bare `<span>` or `<button>` whose entire appearance comes
 * from one class. A `className` nobody styles is an unstyled element and a
 * rule nobody renders is dead weight, and neither produces a warning, a lint
 * error or a build failure — the same contract `listsStyles.test.js` guards
 * one directory over.
 *
 * This pair is where that goes wrong quietly: the map replaced a lineage strip
 * whose stylesheet lived in the middle of a 2,000-line file shared with the
 * card, so a leftover `.knowledge-path` rule would have kept shipping for as
 * long as nobody read past it.
 */
const PREFIX = 'graph-';
const JSX = './RelatedPapersSheet.jsx';
const CSS = './PaperCard.css';

/**
 * `graph-map` and `graph-plot` are read by nothing but the stylesheet; every
 * other name has to appear on both sides. Anything added here needs a reason
 * written next to it, or the entry becomes cover for the drift this test
 * exists to catch.
 */
const NOT_CLASS_NAMES = new Set();

async function readPair() {
  const [component, stylesheet] = await Promise.all([
    readFile(new URL(JSX, import.meta.url), 'utf8'),
    readFile(new URL(CSS, import.meta.url), 'utf8'),
  ]);
  const rendered = new Set([...component.matchAll(new RegExp(`${PREFIX}[a-z0-9-]*`, 'g'))].map(match => match[0]));
  const styled = new Set(
    [...stylesheet.matchAll(new RegExp(`\\.(${PREFIX}[a-z0-9-]*)`, 'g'))].map(match => match[1]),
  );
  return { rendered, styled };
}

test('every class the citation map renders has a rule', async () => {
  const { rendered, styled } = await readPair();
  assert.ok(rendered.size > 10, 'expected to have parsed the component');

  const unstyled = [...rendered]
    .filter(name => !styled.has(name) && !NOT_CLASS_NAMES.has(name))
    .sort();
  assert.deepEqual(unstyled, [], `classes rendered with no rule behind them: ${unstyled.join(', ')}`);
});

test('every citation map rule is still rendered', async () => {
  const { rendered, styled } = await readPair();

  const orphaned = [...styled].filter(name => !rendered.has(name)).sort();
  assert.deepEqual(orphaned, [], `rules for markup that no longer exists: ${orphaned.join(', ')}`);
});

test('the lineage strip the map replaced left nothing behind', async () => {
  const [component, stylesheet] = await Promise.all([
    readFile(new URL(JSX, import.meta.url), 'utf8'),
    readFile(new URL(CSS, import.meta.url), 'utf8'),
  ]);
  assert.equal(/knowledge-path/.test(stylesheet), false, 'the old lineage strip still has rules');
  assert.equal(/knowledge-path/.test(component), false, 'the old lineage strip is still rendered');
});
