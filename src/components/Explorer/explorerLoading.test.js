import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for how an author, an institution or a project page waits, and
 * for how its parts land — the stretch between the skeleton and the words.
 */
test('the skeleton shimmer is a transform on a pseudo-element, not a repainted background', async () => {
  const css = await read('./EntityExplorer.css');
  const exSkel = css.match(/\n\.ex-skel \{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(exSkel, /animation/, 'the block itself does not animate');
  assert.match(css, /\.ex-skel::after \{[^}]*transform: translateX\(-105%\);[^}]*animation: exSkelSweep/s);
  assert.match(css, /@keyframes exSkelSweep \{\s*to \{ transform: translateX\(105%\); \}\s*\}/);
  assert.doesNotMatch(css, /@keyframes skelShimmer/, 'the unused background-position sweep is gone');
});

test('the sweep keeps its phase down the page, now on the pseudo-element', async () => {
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-skeleton \.ex-skel-name::after \{ animation-delay: 0\.06s; \}/);
  assert.match(css, /\.explorer-skeleton \.ex-skel-row:nth-child\(4\) \.ex-skel::after \{ animation-delay: 0\.96s; \}/);
  assert.match(css, /\.ex-skel-row:nth-child\(5\) \.ex-skel::after \{ animation-delay: 0\.48s; \}/);
  // No phase rule is left on the block, where it would now delay nothing.
  assert.doesNotMatch(css, /\.ex-skel \{ animation-delay/);
  assert.doesNotMatch(css, /\.ex-skel-name \{ animation-delay/);
});

test('a skeleton row holds still instead of rising like the row it stands in for', async () => {
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-list-item\.ex-skel-row \{\s*animation: none;\s*\}/);
});

test('reduced motion stops the sweep on the pseudo-element too', async () => {
  const css = await read('./EntityExplorer.css');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(reduced, /\.ex-skel::after,/);
  assert.match(reduced, /\.ehc-stat-value\.is-settled,/);
});

test('an author card resolves from part-way visible, like a paper row', async () => {
  const css = await read('./EntityExplorer.css');
  const rule = css.match(/\.ee-author-card\.staggerFadeUp \{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(rule, /opacity: 0;/);
  assert.match(rule, /animation: staggerFadeUp 0\.42s cubic-bezier\(0\.16, 1, 0\.3, 1\) both;/);
});

test('the ORCID card lands at the page\'s tempo, not over four seconds from nothing', async () => {
  const css = await read('./EntityExplorer.css');
  assert.doesNotMatch(css, /orcidPremiumReveal/);
  assert.doesNotMatch(css, /@keyframes orcidReveal/);
  assert.match(css, /\.orcid-career-section--animate > \* \{\s*animation: staggerFadeUp 0\.42s cubic-bezier\(0\.16, 1, 0\.3, 1\) both;\s*\}/);
  assert.match(css, /\.orcid-career-section--animate > \*:nth-child\(7\) \{ animation-delay: 0\.24s; \}/);
});

test('the recent-impact score settles in place once it is known', async () => {
  const jsx = await read('./RecentImpactStat.jsx');
  assert.match(jsx, /className=\{`ehc-stat-value\$\{!isLoading && \(impact \|\| error\) \? ' is-settled' : ''\}`\}/);
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.ehc-stat-value\.is-settled \{\s*animation: statSettle 0\.3s ease-out both;\s*\}/);
  assert.match(css, /@keyframes statSettle \{\s*from \{ opacity: 0\.35; \}\s*to \{ opacity: 1; \}\s*\}/);
});

test('the list is loading from the first live frame, so the empty-state copy never flashes', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const \[isLoadingPapers, setIsLoadingPapers\] = useState\(true\);/);
  // Every entity load re-arms it: a new entity means a new papers request.
  assert.match(jsx, /async function loadEntity\(\) \{[\s\S]*?setIsLoadingPapers\(true\);[\s\S]*?if \(type === 'topic'/);
});

test('the ORCID record and the impact score are requested together, declared before either starts', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /setEntity\(data\);\s*setIsLoadingEntity\(false\);[\s\S]*?if \(wantsOrcid\) setIsLoadingOrcid\(true\);[\s\S]*?await Promise\.all\(\[\s*wantsRecentImpact \? loadRecentImpact\(\) : null,\s*wantsOrcid \? loadOrcid\(\) : null,\s*\]\);/);
});

test('an institution keeps its Wikipedia block open while the paragraph is on its way', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /isWikiRequestPending && \['concept', 'topic', 'institution'\]\.includes\(type\)/);
});

test('the experience panel grows into place when the ORCID record lands', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /<AnimatePresence>\s*\{isExperienceOpen && \(/);
});

test('switching tabs neither cancels nor repeats a papers request', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const papersRequestRef = useRef\(null\);/);
  assert.match(jsx, /const requestKey = entityPapersRequestKey\(\{/);
  assert.match(jsx, /if \(papersRequestRef\.current\?\.key === requestKey && !papersRequestRef\.current\.cancelled\) return;/);
  const deps = jsx.match(/\n {2}\}, \[(type, id, entity, entityDisplayName, sortBy, page, debouncedSearch, filters, searchParams, papersReloadKey, entityReloadKey)\]\);/);
  assert.ok(deps, 'the papers effect is keyed by its inputs, and activeTab is not one of them');
});

test('the authors list is requested on the first visit to its tab and kept from then on', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const \[authorsOpened, setAuthorsOpened\] = useState\(false\);/);
  assert.match(jsx, /entity\._queryTopic \|\| !authorsOpened\) return;/);
  assert.match(jsx, /\}, \[type, id, entity, authorsPage, debouncedSearch, authorsOpened, authorsReloadKey\]\);/);
  assert.match(jsx, /onClick=\{\(\) => openTab\('authors'\)\}/);
  assert.match(jsx, /setAuthorsOpened\(true\);\s*setIsLoadingAuthors\(true\);/);
});

test('the page skeleton reserves as many rows as the list skeleton paints', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  const pageSkeletonRows = jsx.match(/<div className="explorer-grid">\s*\{\[1, 2, 3, 4, 5\]\.map\(i => \(\s*<div key=\{i\} className="explorer-list-item ex-skel-row">/);
  assert.ok(pageSkeletonRows, 'five rows in the page skeleton');
  assert.match(jsx, /isLoadingPapers && !isFetchingMore && \[1, 2, 3, 4, 5\]\.map/);
});
