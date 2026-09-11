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
  // A local topic — the id a category pill on a card navigates to — resolves
  // from CATEGORIES with no fetch either. Born loading, it painted the skeleton
  // for one commit and settled 109→146 DURING the page's own entrance.
  assert.match(jsx, /const localTopic = useMemo\(\s*\(\) => \(type === 'topic' \|\| type === 'concept' \? getLocalTopicEntity\(id\) : null\),\s*\[id, type\],\s*\);/);
  assert.match(jsx, /const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| Boolean\(cachedEntity\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| cachedEntity \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/);
  assert.match(jsx, /const \[isLoadingEntity, setIsLoadingEntity\] = useState\(\(\) => !bornResolved\);/);
  // And a navigation between entities takes the same shortcut, in the same
  // batch as the reset, so no skeleton commit ever paints.
  assert.match(jsx, /const local = type === 'topic' \|\| type === 'concept' \? getLocalTopicEntity\(id\) : null;\s*if \(local\) \{\s*setEntity\(local\);\s*setIsLoadingEntity\(false\);\s*return;\s*\}/);
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
  // Block body since Task 3 (2026-09-09): the last cell needs to know whether
  // it's the recent-impact one, so the map computes `isImpact` before
  // returning the cell rather than returning it directly.
  assert.match(jsx, /\{Array\.from\(\{ length: shape\.stats \}, \(_, i\) => \{/);
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.project-summary-box--reserved \{\s*font-size: 0\.9375rem;\s*line-height: 1\.6;/);
});

test('the page skeleton asks the route whether an ORCID card is coming', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const shape = explorerSkeletonShape\(type, \{ hasOrcid: Boolean\(extractOrcid\(id\)\) \}\);/);
});

/**
 * The recent-impact cell used to be born one line short. Measured 2026-09-09
 * on a cold author in production, signed in: "Calculating…" laid the cell out
 * at 124×64.5 and the grid at 249×112.9, the score landed 484ms later as
 * "Very high · 2023–2026" and the cell became 131.5×77.5, the grid 264×125.9,
 * and the header — a wrapping flex row — grew 10.3px. Everything under it
 * moved by that much in one frame: the experience panel, the ORCID card, the
 * "Verified ORCID profile" pill. The settle animates the body's bottom edge,
 * not where its children sit. So the grid takes its width up front, the
 * detail its two lines, and the skeleton paints the same cell.
 */
test('the impact cell and its grid are born at the size the score will take', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  // The grid measured to content under a 264px max and reached the max only
  // once the score landed. Pinned — but only where the growing cell exists, so
  // a topic's or a project's aside keeps measuring to its own content.
  assert.match(css, /\.ehc-stats-grid:has\(\.ehc-stat-box--impact\) \{\s*width: 264px;\s*\}/);
  // Two lines of 0.625rem/1.3 mono: 1.625rem.
  assert.match(css, /\.ehc-stat-detail \{[^}]*\n {2}min-height: 1\.625rem;\n\}/);
  // Under 768px the aside spans the row and the grid with it — width wins
  // over the fixed 264 there. Bounded to that media block: pinned by its
  // indentation alone, this would still pass if the rule moved to another
  // breakpoint, which is the one thing the comment above claims.
  const narrow = css.match(/@media \(max-width: 768px\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(narrow, 'the 768px block must exist for the rule below to be bounded by it');
  assert.match(narrow, /\.ehc-hero-aside \.ehc-stats-grid \{\n {4}width: 100%;\n {4}max-width: none;\n {4}flex: 1 1 100%;\n {2}\}/);
  // The skeleton's last cell carries the detail box on the pages that have it.
  // `display: block` is load-bearing: the bar's parent is the `.ehc-stat-detail`
  // span, not the flex `.ehc-stat-box`, so without it the bar stays inline and
  // width/height do nothing.
  assert.match(css, /\.ex-skel-stat-detail \{ display: block; width: 96px; height: 8px; margin-top: 2px; \}/);
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  // The skeleton's last cell IS the impact cell on those pages: it carries the
  // class the `:has()` above keys on, and the detail box that sets the height.
  assert.match(jsx, /const isImpact = shape\.impact && i === shape\.stats - 1;/);
  assert.match(jsx, /className=\{`ehc-stat-box\$\{isImpact \? ' ehc-stat-box--impact' : ''\}`\}/);
  assert.match(jsx, /\{isImpact && \(\s*<span className="ehc-stat-detail"><span className="ex-skel ex-skel-stat-detail"><\/span><\/span>\s*\)\}/);
  // And the LIVE half of the same reservation, which is what the `:has()`
  // actually binds to. The pin only holds while the cell that lands wears
  // `ehc-stat-box--impact`: rename it in RecentImpactStat and the grid goes
  // back to measuring to content, so the score's second line takes it from
  // 249 to 264 and drops the ORCID card 10.3px again — with every assertion
  // above still green, because they only ever look at the skeleton's copy.
  const impactJsx = stripComments(await read('./RecentImpactStat.jsx'));
  assert.match(impactJsx, /className=\{`ehc-stat-box ehc-stat-box--impact\$\{impact\?\.stale \? ' ehc-stat-box--stale' : ''\}`\}/);
  // The other half: which pages mount that cell at all. This list and
  // `explorerSkeletonShape.impact` (author || institution) are two copies of
  // one decision; add a type here and its skeleton reserves no detail line,
  // so that page gets the drop back. Nothing else fails — only a probe run
  // over a cold entity of the new type would show it.
  assert.match(jsx, /\{\['institution', 'author'\]\.includes\(type\) && \(\s*<RecentImpactStat/);
});

/**
 * The feed's project pill already carries the project's name and funder in
 * the URL (Task 2), so the hero does not have to sit behind the full-page
 * skeleton until OpenAIRE answers — it can paint immediately and reserve,
 * INSIDE the live hero, only the two pieces the pill cannot know: the
 * summary box and two stat cells. `_detailsPending` marks that optimistic
 * entity so the hero knows what to reserve, and clears once the real
 * details land (or, name-less, once the id-as-name fallback lands instead).
 */
test('a project arriving with a name from the pill paints the hero right away and reserves inside it what OpenAIRE has not answered yet', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(
    jsx,
    /setEntity\(\{ id, display_name: name, type: 'project', funder, _detailsPending: true \}\);\s*setIsLoadingEntity\(false\);/,
  );
  assert.match(
    jsx,
    /\{type === 'project' && entity\._detailsPending && <ProjectSummarySkeleton \/>\}/,
  );
  assert.match(
    jsx,
    /entity\._detailsPending && \[1, 2\]\.map\(/,
    'two reserved stat cells',
  );
  // The live project stat cell and the page skeleton's both use `ehc-stat-box`
  // — there is no `.explorer-stat` anywhere in this codebase — so the
  // reserved cell must borrow that class, not invent its own, or it reserves
  // the wrong height.
  assert.match(
    jsx,
    /<div key=\{`stat-reserved-\$\{n\}`\} className="ehc-stat-box" aria-hidden="true">\s*<span className="ex-skel ex-skel-stat-value"><\/span>\s*<span className="ex-skel ex-skel-stat-label"><\/span>\s*<\/div>/,
  );
  // Fix round 1 (2026-09-11): `else if (!name)` only ran for a name-less URL,
  // so a failed lookup after a name-carrying optimistic entity had already
  // painted (the normal pill path) hit neither arm — `_detailsPending` was
  // never cleared and the reserved summary box plus the two reserved stat
  // cells shimmered forever with nothing ever arriving. The arm must be a
  // plain, unconditional `else` (no `if (!name)` beside it) that lands an
  // entity with no `_detailsPending`, keeping the pill's name when there was
  // one.
  assert.match(
    jsx,
    /\} else \{\s*setEntity\(\{\s*id,\s*openaireId: id\.includes\('::'\) \? id : undefined,\s*display_name: name,\s*type: 'project',\s*funder,\s*\}\);\s*\}/,
    'the failed-lookup arm is unconditional and sets no _detailsPending',
  );
});

/**
 * What the failed-lookup arm lands still has to make a readable page.
 *
 * Two holes it left open. The entity carried no `openaireId`, so the empty
 * state dropped its "View on OpenAIRE" link in exactly the case where sending
 * the reader to OpenAIRE helps most — and when the route id is itself an
 * OpenAIRE id (it contains "::"), that link was one field away. And with no
 * name in the URL the hero title read
 * `snsf________::daa28096f9e8879ab3a02b90aa0e2f83`: a raw identifier is not a
 * title. The page already has bilingual wording for what this is.
 */
test('a project whose lookup failed still links out and still has a title', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));

  assert.doesNotMatch(jsx, /display_name: name \|\| id,/, 'the raw id is no longer a title');
  // The wording stands in where the title is RENDERED, never inside the
  // entity: `display_name` is what the follow identity is built from, and one
  // constant shared by every nameless project made them all the same follow.
  // explorerProjectIdentity.test.js holds that reasoning and the rest of this
  // rule; what belongs here is only that the hero still has a title.
  assert.match(
    jsx,
    /<h1 className="ehc-name" style=\{\{ margin: 0 \}\}>\{entityDisplayName \|\| entityTypeLabel\}<\/h1>/,
    "the hero title falls back to the page's own bilingual label for the type",
  );
  assert.match(
    jsx,
    /openAireUrl=\{entity\?\.openaireId \? `https:\/\/explore\.openaire\.eu\/search\/project\?projectId=\$\{encodeURIComponent\(entity\.openaireId\)\}` : null\}/,
    'the empty state links out from that same field',
  );
});
