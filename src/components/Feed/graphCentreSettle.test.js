import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE test for the one measurement the citation map is built on.
 *
 * `buildCitationMapLayout` puts the centre -- the black dot and its "This
 * paper" label -- at `ruleY = height / 2`, where `height` is the measured
 * height of `.graph-plot`. The plot is `flex: 1 1 auto` inside a sheet whose
 * own height is fixed, so ANY sibling that appears late takes its space out
 * of the plot, and the centre moves by half of it.
 *
 * That is what the provenance row did. `.knowledge-source` is exactly
 * `--graph-source-height` (30px) tall and was rendered only once the graph
 * had loaded, while the sheet already stood at its full height from the first
 * frame (`sheetStatus` reports a loading graph as ready, so the sheet does
 * not resize under the reader). Measured 2026-09-07 at 1280x900: the sheet
 * finished arriving at ~740ms and stood still; the graph landed at ~1834ms,
 * the plot went from 366px to 336px in one frame and the centre jumped 15px
 * up on the next. Long after everything looked settled, which is why it read
 * as the label moving on its own.
 *
 * The row is reserved now: it is rendered for as long as the sheet stands at
 * its graph height, and only its text waits for the data. The rule below is
 * the general one -- nothing may enter or leave the column around the plot
 * after the first frame -- and this is the one place it was broken.
 */

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the provenance row holds its 30px from the first frame, so the plot never resizes under the centre', async () => {
  const jsx = await read('./RelatedPapersSheet.jsx');

  // Rendered with the sheet's graph height, not with the data.
  assert.match(
    jsx,
    /\{mode === 'graph' && sheetStatus === 'ready' && \(\s*<div className="knowledge-source">/,
    'the row is back to appearing with the data, which takes 30px off the plot mid-flight',
  );
  // The exact shape that caused it. `graphStatus === 'ready'` may still gate
  // the TEXT -- what it must not gate any more is the box.
  assert.doesNotMatch(
    jsx,
    /graphStatus === 'ready' && \(\s*<div className="knowledge-source">/,
    'the box must not wait for the graph; only its text may',
  );
});

test('the centre is placed at half the plot, which is what makes a late sibling move it', async () => {
  const layout = await read('../../utils/citationMap.js');
  assert.match(layout, /const ruleY = height \/ 2;/);

  const css = await read('./PaperCard.css');
  // The three facts that turn 30px of sibling into 15px of jump.
  assert.match(css, /\.graph-plot\s*\{[^}]*flex:\s*1 1 auto/, 'the plot takes what the column leaves');
  assert.match(css, /\.knowledge-source\s*\{[^}]*height:\s*var\(--graph-source-height\)/);
  assert.match(css, /--graph-source-height:\s*30px/);
});

/**
 * The centre also moves SIDEWAYS, and for a reason that only exists once the
 * data is in: the horizontal axis is a log scale built from the neighbourhood,
 * so until the graph lands there is no scale and the centre stands at the
 * middle of the plot. When it lands, the centre goes to the column its own
 * citation count earns. Measured 2026-09-07 at 1280x900: 533.6px in a single
 * frame, with the label crossing to the other side of the dot in that same
 * frame. It is a move, so it is animated as one.
 */
test('the centre carries its column on `translate`, never on `left`, so the move can be transitioned', async () => {
  const jsx = await read('./RelatedPapersSheet.jsx');

  // The x is handed over as a variable; the stylesheet decides what property
  // it lands on. `left` would lay the plot out again every frame, and
  // `transform` is taken -- `relatedItemIn` animates it.
  assert.match(jsx, /'--mark-x': `\$\{\(isArriving && !hasSlid \? previousCenterX : layout\.centerX\) - 8\}px`/);
  assert.match(jsx, /'--chip-x': chipOnLeft\s*\? `calc\(\$\{layout\.centerX - 16\}px - 100%\)`\s*: `\$\{layout\.centerX \+ 16\}px`/);

  // Both sides measured from the same edge: a crossing is one value changing,
  // which a transition can carry, not two anchors swapping.
  const mark = jsx.slice(jsx.indexOf('className={`graph-mark'), jsx.indexOf('className={`graph-chip'));
  assert.doesNotMatch(mark, /\bleft:/, 'the dot is placed by translate now');
  const chip = jsx.slice(jsx.indexOf('className={`graph-chip'));
  const chipStyle = chip.slice(0, chip.indexOf('>'));
  assert.doesNotMatch(chipStyle, /\bright:\s*`/, 'the label anchored by `right` cannot cross sides smoothly');
});

test('the move is a transition on translate, with the curve declared for a distance that has to be seen', async () => {
  const css = await read('./PaperCard.css');

  for (const selector of ['.graph-mark', '.graph-chip']) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] || '';
    assert.match(rule, /translate: var\(--(mark|chip)-x/, `${selector} lost its column variable`);
    assert.match(
      rule,
      /transition: translate 0\.28s var\(--ease-out-quad\)/,
      `${selector} must move on the token declared for a movement that has to be seen travel, `
      + 'not on the house expo -- over half the width of the plot the expo reads as a cut with a tail',
    );
    assert.doesNotMatch(rule, /transition:[^;]*\bleft\b/, 'a transition on `left` lays the plot out every frame');
  }

  // Movement goes under reduced motion; the centre arrives where it belongs.
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  const block = reduced.match(/\.graph-rule,[\s\S]*?\}/)?.[0] || '';
  assert.match(block, /\.graph-mark,/);
  assert.match(block, /\.graph-chip,/);
  assert.match(block, /transition: none;/);
});
