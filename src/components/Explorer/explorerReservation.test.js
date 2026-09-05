import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for what the skeleton RESERVES against what lands. Measured on a
 * phone (390px) with a probe that dumps each block's height on the first
 * skeleton frame and once settled; every number below is one of those.
 */

/**
 * The shortest paper row that ever lands is 199px: a 15px header, two lines of
 * serif title, one of authors and two of summary. The skeleton reserved 138 —
 * two 19px title bars 9px apart, a 12px authors bar, and nothing for the
 * summary the live row always carries — so every row grew ~61px the frame the
 * words landed, ~305px over five.
 */
test('the skeleton paper row reserves the live row\'s line boxes, summary included', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  const rows = jsx.match(/<div className="ex-skel ex-skel-title"><\/div>\s*<div className="ex-skel ex-skel-title"><\/div>\s*<div className="ex-skel ex-skel-authors"><\/div>\s*<div className="ex-skel ex-skel-summary"><\/div>\s*<div className="ex-skel ex-skel-summary ex-skel-summary--short"><\/div>/g) || [];
  assert.equal(rows.length, 2, 'both the page skeleton and the list skeleton paint the summary');

  const css = stripComments(await read('./EntityExplorer.css'));
  // Header: 15 of line, 10 below — `.eli-header`.
  assert.match(css, /\.ex-skel-row-head \{[^}]*min-height: 15px;\s*margin-bottom: 10px;[^}]*\}/);
  // Title: a 19px bar in each 24.6px line, then the title's own 8px.
  assert.match(css, /\.ex-skel-title \{ height: 19px; margin-bottom: 11px;/);
  assert.match(css, /\.ex-skel-title \+ \.ex-skel-title \{ width: 58%; margin-bottom: 8px; \}/);
  // Authors: 21 of line plus 8 below. Summary: two 23.25px lines.
  assert.match(css, /\.ex-skel-authors \{ height: 12px; width: 42%; margin: 4px 0 13px; \}/);
  assert.match(css, /\.ex-skel-summary \{ height: 12px; margin: 5px 0 6px;/);
  // A grid, or the bars' margins collapse and the row comes up 10px short.
  assert.match(css, /\.explorer-list-item\.ex-skel-row \{ display: grid; \}/);
});

/**
 * A free-text topic is resolved from the route with no fetch behind it. Born
 * loading, the page painted the full skeleton for one frame and then settled
 * the hero body from ~434px down to the 130 the topic has — a wait that never
 * happened, animated. Born resolved, there is no skeleton frame at all.
 */
test('a query topic is born resolved rather than loading', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const bornResolved = type === 'topic' && isOpaqueQueryTopicText\(id\);/);
  assert.match(jsx, /useState\(\(\) => \(bornResolved \? resolveQueryTopicRoute\(id, searchParams\) : null\)\)/);
  assert.match(jsx, /const \[isLoadingEntity, setIsLoadingEntity\] = useState\(\(\) => !bornResolved\);/);
  // And with none of the counts, the ruled grid does not paint as a 1px line.
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.ehc-stats-grid:empty \{\s*display: none;\s*\}/);
});

/**
 * A project hero landed 276px taller than its skeleton; 122 of it was the
 * summary box OpenAIRE returns for nearly every grant, and four stat cells were
 * reserved where two land. The reservation borrows the Wikipedia block's rows,
 * which are sized in em — so the box sets the size the rows measure against.
 */
test('the project skeleton reserves its summary box and the stat cells that land', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const ProjectSummarySkeleton = \(\) => \(\s*<div className="project-summary-box project-summary-box--reserved" aria-hidden="true">\s*<div className="ehc-wiki-skeleton">/);
  assert.match(jsx, /\{shape\.aside === 'summary' && <ProjectSummarySkeleton \/>\}/);
  assert.match(jsx, /\{Array\.from\(\{ length: shape\.stats \}, \(_, i\) => \(/);
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.project-summary-box--reserved \{\s*font-size: 0\.9375rem;\s*line-height: 1\.6;/);
});
