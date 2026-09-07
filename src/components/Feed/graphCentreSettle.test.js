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
