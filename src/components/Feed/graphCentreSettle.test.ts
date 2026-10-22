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
 * The row is gone now, and the band captions above the plot
 * with it. The rule below is the general one -- nothing may enter or leave
 * the column around the plot after the first frame.
 */

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = async (path: string|URL) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('no row comes and goes around the plot once the sheet stands', async () => {
  const jsx = await read('./RelatedPapersSheet.tsx');
  // The provenance row and the band captions are gone, not just hidden.
  assert.doesNotMatch(jsx, /knowledge-source|graph-band-head/);
  // The trail depends on the walk, never on the data landing.
  assert.match(jsx, /\{isWalking && \(\s*<div className="graph-trail"/);
});

test('the centre is placed at half the plot, which is what makes a late sibling move it', async () => {
  const layout = await read('../../utils/citationMap.ts');
  assert.match(layout, /const midY = height \/ 2;/);
  assert.match(layout, /const centerY = ready && centerImpactKnown \? yForImpact\(impactOf\(center\)\) : midY;/);

  const css = await read('./PaperCard.css');
  // Why a late sibling would move it: the plot takes what the column leaves.
  assert.match(css, /\.graph-plot\s*\{[^}]*flex:\s*1 1 auto/, 'the plot takes what the column leaves');
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
  const jsx = await read('./RelatedPapersSheet.tsx');

  // The x is handed over as a variable; the stylesheet decides what property
  // it lands on. `left` would lay the plot out again every frame, and
  // `transform` is taken -- `rise` animates it.
  assert.match(jsx, /'--mark-x': `\$\{\(isArriving && !hasSlid \? previousCenter\.x : layout\.centerX\) - 8\}px`/);
  // On the timeline the centre moves up and down too: its height is its count.
  assert.match(jsx, /'--mark-y': `\$\{\(isArriving && !hasSlid \? previousCenter\.y : layout\.centerY\) - 8\}px`/);
  assert.match(jsx, /'--chip-y': `\$\{layout\.centerY\}px`/);
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
  const block = reduced.match(/\.graph-now,[\s\S]*?\}/)?.[0] || '';
  assert.match(block, /\.graph-mark,/);
  assert.match(block, /\.graph-chip,/);
  assert.match(block, /transition: none;/);
});
