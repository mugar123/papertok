import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

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

  // The claim is the SHAPE of the ladder, not its numbers: each group's phase
  // grows as the eye goes down it, so the sweep reads as one wave passing
  // rather than as every block pulsing at once. Pinned as an ordering because
  // the numbers are tuned against how long the skeleton actually stands
  // (explorerMotion.test.ts caps them against that measurement), and three
  // magic values here broke every time they were.
  const phasesOf = (pattern: RegExp) => [...css.matchAll(pattern)].map(([, seconds]) => Number(seconds));
  const rising = (values: number[], what: string) => {
    assert.ok(values.length >= 3, `${what}: expected a ladder, got ${values.length} step(s)`);
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i] > values[i - 1], `${what}: step ${i} (${values[i]}s) must come after ${values[i - 1]}s`);
    }
  };

  rising(
    phasesOf(/\.explorer-skeleton \.ex-skel-strip \.ex-skel(?::nth-child\(\d\))?::after \{ animation-delay: ([\d.]+)s; \}/g),
    'the identity strip',
  );
  rising(
    phasesOf(/\.explorer-skeleton \.ex-skel-row:nth-child\(\d\) \.ex-skel::after \{ animation-delay: ([\d.]+)s; \}/g),
    'the five waiting rows',
  );
  rising(
    phasesOf(/\.explorer-skeleton \.ehc-wiki-skeleton span:nth-child\(\d\)::after \{ animation-delay: ([\d.]+)s; \}/g),
    'the project summary lines',
  );
  // The list skeleton the live page paints while it loads more keeps its own.
  rising(
    phasesOf(/\n\.ex-skel-row:nth-child\(\d\) \.ex-skel::after \{ animation-delay: ([\d.]+)s; \}/g),
    'the live list skeleton',
  );
  // The head of the page still leads the wave.
  const head = phasesOf(/\.explorer-skeleton \.ex-skel-type::after \{ animation-delay: ([\d.]+)s; \}/g);
  assert.deepEqual(head, [0], 'the type kicker is where the wave starts');

  // No phase rule is left on the block, where it would now delay nothing.
  assert.doesNotMatch(css, /\.ex-skel \{ animation-delay/);
  assert.doesNotMatch(css, /\.ex-skel-name \{ animation-delay/);
});

test('nothing is left of the page skeleton reserving the Wikipedia block', async () => {
  const jsx = (await read('./EntityExplorer.tsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(jsx, /WikiBlockSkeleton/, "explorerSkeletonShape never answers 'wiki' any more, so the component was unreachable");
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.doesNotMatch(css, /\.ehc-wiki--reserved/);
  assert.doesNotMatch(css, /\.explorer-skeleton \.ehc-wiki-skeleton span:nth-child\(5\)/, 'no skeleton under the page skeleton has a fifth span (the in-block rows of a re-lookup do, and keep theirs)');
});

test('a skeleton row wears the live list row and only phases its shimmer', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  const css = await read('./EntityExplorer.css');
  assert.match(jsx, /className="list-row ex-skel-row"/);
  assert.doesNotMatch(css, /\.ex-skel-row \{[^}]*animation:(?! none)/);
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
  assert.match(rule, /animation: staggerFadeUp var\(--motion-base\) var\(--ease-out\) both;/);
});

test('the ORCID card lands at the page\'s tempo, not over four seconds from nothing', async () => {
  const css = await read('./EntityExplorer.css');
  assert.doesNotMatch(css, /orcidPremiumReveal/);
  assert.doesNotMatch(css, /@keyframes orcidReveal/);
  assert.match(css, /\.orcid-career-section--animate > \* \{\s*animation:\s*slideUpFade var\(--motion-base\) linear backwards,\s*authorContentTravel var\(--motion-base\) var\(--ease-out\) backwards;\s*\}/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.ehc-experience-panel \.orcid-timeline-item,/);
  assert.match(css, /\.orcid-career-section--animate > \*:nth-child\(n \+ 5\) \{ animation-delay: 0\.16s; \}/);
});

test('the recent-impact score settles in place once it is known', async () => {
  const jsx = await read('./RecentImpactStat.tsx');
  assert.match(jsx, /className=\{`ehc-stat-value\$\{!isLoading && \(impact \|\| error\) \? ' is-settled' : ''\}`\}/);
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.ehc-stat-value\.is-settled \{\s*animation: slideUpFade 0\.3s ease-out both;\s*\}/);
  assert.match(css, /@keyframes slideUpFade \{\s*from \{ opacity: 0\.35; \}\s*to \{ opacity: 1; \}\s*\}/);
});

test('the experience panel grows into place when the ORCID record lands', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /<AnimatePresence>\s*\{isExperienceOpen && \(/);
});

test('switching tabs neither cancels nor repeats a papers request', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /const papersRequestRef = useRef<\{ key: string; cancelled: boolean \} \| null>\(null\);/);
  assert.match(jsx, /const requestKey = entityPapersRequestKey\(\{/);
  assert.match(jsx, /if \(papersRequestRef\.current\?\.key === requestKey && !papersRequestRef\.current\.cancelled\) return;/);
  const deps = jsx.match(/\n {2}\}, \[(afterPageArrival, type, id, entity, entityDisplayName, sortBy, page, debouncedSearch, filters, searchParams, papersReloadKey, entityReloadKey, publicMode, requestNextPapersPage)\]\);/);
  assert.ok(deps, 'the papers effect is keyed by its inputs, and activeTab is not one of them');
});

test('the authors list is requested on the first visit to its tab and kept from then on', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  // Seeded from the visit memory since 2026-09-18 (explorerResume.test.ts); a
  // first visit still starts closed.
  assert.match(jsx, /const \[authorsOpened, setAuthorsOpened\] = useState(?:<[^;\n]+>)?\(\(\) => Boolean\(resumed\?\.authorsOpened\)\);/);
  assert.match(jsx, /entity\._queryTopic \|\| !authorsOpened\) return;/);
  assert.match(jsx, /\}, \[type, id, entity, authorsPage, debouncedSearch, authorsOpened, authorsReloadKey\]\);/);
  assert.match(jsx, /onValueChange=\{\(\[next\]\) => \{ if \(next\) openTab\(next\); \}\}/);
  assert.match(jsx, /<ToggleGroupItem value="authors">/);
  assert.match(jsx, /setAuthorsOpened\(true\);\s*setIsLoadingAuthors\(true\);/);
});

test('the page skeleton reserves as many rows as the list skeleton paints', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  const pageSkeletonRows = jsx.match(/<div className="explorer-grid">\s*\{\[1, 2, 3, 4, 5\]\.map\(i => \(\s*<div key=\{i\} className="list-row ex-skel-row">/);
  assert.ok(pageSkeletonRows, 'five rows in the page skeleton');
  assert.match(jsx, /isLoadingPapers && !isFetchingMore && \[1, 2, 3, 4, 5\]\.map/);
});

/**
 * With the settle owning the space, the fold's wrapper has nothing to clip: the
 * hero body clips while it grows. A leftover `overflow: hidden` on the wrapper
 * would only cut the paragraph's own "Read more" transition.
 */
test('the fold wrapper is a plain box now', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.doesNotMatch(css, /\.ehc-wiki-fold \{/, 'no rule of its own');
});

test('the list mounts in idle chunks, rows below the fold are skipped, and the sentinel waits for the page', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /const \[rowBudget, setRowBudget\] = useState(?:<[^;\n]+>)?\(EXPLORER_ROW_CHUNK\);/);
  assert.match(jsx, /const mountedPapers = useMemo(?:<[^;\n]+>)?\(\(\) => filteredPapers\.slice\(0, rowBudget\), \[filteredPapers, rowBudget\]\);/);
  assert.match(jsx, /const rowsSettled = rowBudget >= filteredPapers\.length;/);
  assert.match(jsx, /setRowBudget\(\(budget\) => nextExplorerRowBudget\(budget, filteredPapers\.length\)\)/);
  assert.match(jsx, /if \(page === 1\) \{\s*setIsLoadingPapers\(true\);\s*setPapersError\(null\);\s*setRowBudget\(EXPLORER_ROW_CHUNK\);/, 'a fresh page starts over at one chunk');
  // `hasMore && rowsSettled` sigue abriendo la puerta; desde el 12-09 lleva
  // además una guarda para no invitar a bajar por una lista vacía, así que
  // aquí se fija el principio de la condición y el destino, no su literal.
  assert.match(jsx, /hasMore && rowsSettled &&[\s\S]{0,80}<div ref=\{observerRef\} className="ehc-sentinel">/);
  // `visiblePapers` es `mountedPapers` recortado para quien mira sin cuenta
  // (dos filas); con sesión es la misma lista, así que el troceado en ralentí
  // que este test defiende sigue siendo lo que decide qué se monta.
  assert.match(jsx, /const visiblePapers = useMemo(?:<[^;\n]+>)?\(\(\) => guestPreviewRows\(mountedPapers, \{ publicMode \}\)/);
  assert.match(jsx, /visiblePapers\.map\(\(paper, idx\) => \(/);
  assert.match(jsx, /<PaperListRow\s+key=/, 'each paper is the shared list row');
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-grid > \.list-row:not\(\.ex-skel-row\) \{\s*content-visibility: auto;\s*contain-intrinsic-size: auto 100px;\s*\}/);
});

// With no row there is no sentinel to ask for page 2, so the page's landing
// asks (`explorerListState`). explorerEmptyState.test.ts checks that the
// empty state waits for the same rule.
test('a page the filters emptied asks for the next one', async () => {
  const jsx = stripComments(await read('./EntityExplorer.tsx'));
  assert.match(
    jsx,
    /setHasMore\(page \* 30 < total\);\s*if \(explorerListState\(\{ rows: fetchedPapers\.length, hasMore: page \* 30 < total, publicMode \}\) === 'looking'\) \{\s*continuing = requestNextPapersPage\(false\);\s*\}/,
    'a page that adds no row asks for the next one on the list\'s own allowance',
  );
  assert.match(jsx, /setIsLoadingPapers\(false\);\s*setIsFetchingMore\(continuing\);/, 'the list stays loading while it asks');
});

// entityExplorer.test.ts checks `explorerPageAllowance` by hand; this checks
// that the component pages through it. A foot that turned the page itself, or
// that asked as the reader every time, let one reader action load every page
// the filters emptied until OpenAlex ran out.
test('the list asks for its next page only through the allowance', async () => {
  const jsx = stripComments(await read('./EntityExplorer.tsx'));

  const ask = jsx.match(/const requestNextPapersPage = useCallback\(\(byReader: boolean\) => \{[\s\S]*?\n {2}\}, \[\]\);/)?.[0] || '';
  assert.match(
    ask,
    /const left = explorerPageAllowance\(papersAutoPagesRef\.current, \{ byReader \}\);\s*if \(left === null\) \{\s*setPapersAwaitReader\(true\);\s*return false;\s*\}\s*papersAutoPagesRef\.current = left;/,
    'a request spends what is left, and with nothing left waits for "Keep looking"',
  );

  const observer = jsx.match(/new IntersectionObserver\([\s\S]*?\{ threshold: 0\.1 \}/)?.[0] || '';
  const papersFoot = observer.match(/if \(activeTab === 'papers'\) \{[\s\S]*?\} else if \(entries\[0\]\.isIntersecting && activeTab === 'authors'/)?.[0] || '';
  assert.match(papersFoot, /requestNextPapersPage\(papersFootHiddenRef\.current\);/, 'the foot asks as the reader only after the reader scrolled it back into view');
  assert.doesNotMatch(papersFoot, /setPage\(/, 'the foot does not turn the page outside the allowance');

  assert.match(
    jsx,
    /if \(page === 1\) \{[^}]*papersAutoPagesRef\.current = EXPLORER_AUTO_PAGES;[^}]*\}\s*else setIsFetchingMore\(true\);/,
    'a new list starts with the whole allowance',
  );
});

// A failed page sets an error and ends `hasMore`. A button that unmounted
// then took keyboard focus with it, back to the top of the document.
test('"Keep looking" stays mounted and focusable after the page it asked for fails', async () => {
  const jsx = stripComments(await read('./EntityExplorer.tsx'));
  assert.match(jsx, /setPapersError\('PUBLICATIONS_LOAD_FAILED'\);\s*setHasMore\(false\);/);
  assert.match(
    jsx,
    /\{!publicMode && papersAwaitReader && \(\s*<div className="explorer-list-more">\s*<Button[^>]*disabled=\{isFetchingMore \|\| !hasMore\}\s*focusableWhenDisabled/,
    'neither the error nor the end of the pages takes the button away',
  );
});

// The status was emptied when that page failed, leaving the failure to the
// error strip, which is inserted with its text in it and may go unannounced.
// The status is the region that is mounted before it speaks.
test('a "Keep looking" page that fails under rows is said by the mounted status', async () => {
  const jsx = stripComments(await read('./EntityExplorer.tsx'));
  const statusChain = jsx.match(/let papersMoreStatus[^\n]*\n\s*if \(papersAwaitReader\) \{[\s\S]*?\n\s*\}/)?.[0] || '';
  assert.match(
    statusChain,
    /else if \(!papersError\) papersMoreStatus = '[^']+';\s*else if \(filteredPapers\.length > 0\) papersMoreStatus = '[^']+';\s*\}$/,
    'after the end of the pages, a failure with rows on screen has words of its own',
  );
  assert.match(jsx, /\{!publicMode && \(\s*<p className="explorer-list-more-status" role="status">\{papersMoreStatus\}<\/p>/);
});

/**
 * OpenAIRE's `total` counts every publication of the project, whether or not
 * it carries a DOI or an arXiv id; `getPapersByProject` already drops the ones
 * with neither. Left alone, a page that yields zero usable papers still made
 * `hasMore` (`page * 30 < total`) come out true, so the sentinel asked for the
 * next page immediately — the spinner chained through empty page after empty
 * page instead of ever stopping. A page with nothing usable must not promise
 * a next one.
 *
 * The first cut measured the wrong quantity: it counted the identifiers
 * OpenAIRE returned, not the rows that reached the list. The rows come from
 * `fetchPapersByIds` / `enrichPapersBatch` / `fetchPapersByDois`, each wrapped
 * in `settleWithin` and dropped in silence when it times out — so a project
 * with 39 publications on a slow connection returned 30 usable identifiers
 * (`total = 39`, the sentinel kept paging) and zero rows, under an empty state
 * claiming OpenAIRE had linked nothing to the project. Two counts, kept apart:
 * both end the pagination, and only the second is an error.
 */
test('a project page tells an unindexed project from a load that failed, and ends the pagination for both', async () => {
  const src = stripComments(await read('./EntityExplorer.tsx'));

  assert.doesNotMatch(
    src,
    /const usable = res\.arxivIds\.length/,
    'the single-number rule, which could not tell the two cases apart, is gone',
  );
  assert.match(
    src,
    /projectUsableIds = arxivIds\.length \+ dois\.length;\s*total = res\.total;/,
    'what OpenAIRE returned is counted where it is returned, and judged later',
  );
  assert.match(
    src,
    /if \(type === 'project'\) \{\s*projectResolvedRows = fetchedPapers\.length;/,
    'what reached the list is counted before the filter narrows it',
  );

  const cut = src.match(/if \(type === 'project' && \(projectUsableIds === 0 \|\| projectResolvedRows === 0\)\) \{[^}]*\}/);
  assert.ok(cut, 'one cut, reading both counts');
  assert.ok(cut[0].split('\n').length <= 6, `the cut capture spans ${cut[0].split('\n').length} lines, past what it names`);
  assert.match(cut[0], /total = page \* 30;/, 'either zero ends the pagination');
  assert.match(
    cut[0],
    /if \(projectUsableIds > 0\) setPapersError\('PUBLICATIONS_LOAD_FAILED'\);/,
    'identifiers that resolved into nothing are a load failure, not an unindexed project',
  );
});

