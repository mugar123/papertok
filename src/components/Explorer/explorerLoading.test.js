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

  // The claim is the SHAPE of the ladder, not its numbers: each group's phase
  // grows as the eye goes down it, so the sweep reads as one wave passing
  // rather than as every block pulsing at once. Pinned as an ordering because
  // the numbers are tuned against how long the skeleton actually stands
  // (explorerMotion.test.js caps them against that measurement), and three
  // magic values here broke every time they were.
  const phasesOf = (pattern) => [...css.matchAll(pattern)].map(([, seconds]) => Number(seconds));
  const rising = (values, what) => {
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
    'the Wikipedia lines',
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
  assert.match(jsx, /setEntity\(data \|\| handedEntity\);\s*setIsLoadingEntity\(false\);[\s\S]*?if \(wantsOrcid\) setIsLoadingOrcid\(true\);[\s\S]*?await Promise\.all\(\[\s*wantsRecentImpact \? loadRecentImpact\(\) : null,\s*wantsOrcid \? loadOrcid\(\) : null,\s*\]\);/);
});

/**
 * The block arrives rather than appears: it mounts once its lookup has SETTLED,
 * with everything it is ever going to have, and unfolds from nothing.
 *
 * Gated on settled and not merely on content. `homepage_url` comes with the
 * entity and the prose comes later, so a condition that accepted the homepage
 * alone would mount the block early and let the paragraph grow it a second
 * time — one arrival animation, then an unannounced resize under it.
 */
test('the Wikipedia block waits for its lookup to settle, then arrives as one mount', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const showWikiBlock = !isWikiRequestPending && Boolean\(wikiDescription \|\| entity\?\.homepage_url\);/,
    'the block does not exist while its lookup is out');
  assert.match(jsx, /\{showWikiBlock && \(/, 'and that is the only thing that mounts it');
  // While it animates its own height it owns the box, and the hero's settle
  // stands down: measured, a settle reading the box mid-unfold took a target
  // 59.2px short of the truth and snapped the difference when it released.
  assert.match(jsx, /onAnimationStart=\{\(\) => \{ wikiFoldAnimatingRef\.current = true; \}\}/);
  assert.match(jsx, /onAnimationComplete=\{\(\) => \{ wikiFoldAnimatingRef\.current = false; \}\}/);
  assert.doesNotMatch(jsx, /isWikiRequestPending && \['concept', 'topic', 'institution'\]\.includes\(type\)/,
    'and it is no longer held open on grey rows for the whole wait');
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

/**
 * A topic whose Wikipedia lookup misses folds its block away. Measured before
 * the fix: the block's `height` reached 0 but its padding and border (26px)
 * stayed, and the parent's 16px flex gap went with it at unmount — the list
 * jumped 42px in one frame after a 400ms fold that had looked finished.
 */
test('the Wikipedia block folds inside a wrapper that also absorbs the stack gap', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const HERO_STACK_GAP_PX = 16;/);
  // No `layout` on the fold: the hero body's settle already carries this
  // height, and a projection on top of it scaled the paragraph (measured:
  // scaleY 1.21 for 380ms on a topic, 1.3 for a frame on an institution).
  const fold = jsx.match(/<motion\.div\s+className="ehc-wiki-fold"[\s\S]*?>\s*<div\s+className=\{`ehc-wiki /);
  assert.ok(fold, 'the fold declares no layout projection');
  assert.doesNotMatch(fold[0], /\blayout\b/);
  assert.ok(fold, 'the motion wrapper is a box of its own around the padded `.ehc-wiki`');
  assert.match(fold[0], /initial=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, height: 0, marginTop: -HERO_STACK_GAP_PX, y: -8 \}\}/);
  assert.match(fold[0], /animate=\{\{ opacity: 1, height: 'auto', marginTop: 0, y: 0 \}\}/);
  assert.match(fold[0], /exit=\{prefersReducedMotion\s*\?\s*\{ opacity: 0 \}\s*:\s*\{ opacity: 0, height: 0, marginTop: -HERO_STACK_GAP_PX, y: -6, transition: WIKI_FOLD_OUT \}\}/);
  // The arrival opens ~155px of space and everything below rides it, which is
  // the case the project badge was measured on: an expo-out spends most of its
  // travel in the first frames, so the list leaps and then crawls. Simulated at
  // 60fps over 155px, the 420ms expo-out this replaced peaks at 35.4px in one
  // frame; `--ease-out-quad` at 320ms peaks at 15.2px, in less time.
  assert.match(fold[0], /height: \{ duration: 0\.32, ease: \[0\.25, 0\.46, 0\.45, 0\.94\] \}/);
  assert.match(fold[0], /marginTop: \{ duration: 0\.32, ease: \[0\.25, 0\.46, 0\.45, 0\.94\] \}/);
  assert.match(fold[0], /y: \{ duration: 0\.32, ease: \[0\.25, 0\.46, 0\.45, 0\.94\] \}/);
  assert.doesNotMatch(fold[0], /duration: 0\.42/, 'the arrival no longer runs the expo-out that front-loads it');
  // Opacity lands first, so the words are readable while the box still opens.
  assert.match(fold[0], /opacity: \{ duration: 0\.24 \}/);
  // The collapse is not the arrival reversed: what moves is the list below,
  // and it has to land. What this pins is the worst single frame, because that
  // is the jolt. Measured on `explorer-loading-probe.mjs wikiexit`: the
  // arrival's expo-out at 420ms gave -31.9px, the catalog's steep ease-in-out
  // at 280ms gave -39.7px (right shape, too few frames to spend the peak over),
  // and this pair gives -16.0px. The fade keeps the house exit curve, and it
  // tracks the collapse rather than racing it: 400 against 480 is an 80ms tail,
  // where every earlier version left the list moving under an invisible block
  // for 120ms or more.
  const foldOut = jsx.match(/const WIKI_FOLD_OUT = \{[\s\S]*?\n\};/);
  assert.ok(foldOut, 'the fold has a closing transition of its own');
  assert.match(foldOut[0], /opacity: \{ duration: 0\.4, ease: \[0\.4, 0, 1, 1\] \}/);
  assert.match(foldOut[0], /height: \{ duration: 0\.48, ease: \[0\.4, 0, 0\.2, 1\] \}/);
  assert.match(foldOut[0], /marginTop: \{ duration: 0\.48, ease: \[0\.4, 0, 0\.2, 1\] \}/);
  assert.match(foldOut[0], /y: \{ duration: 0\.48, ease: \[0\.4, 0, 0\.2, 1\] \}/);
  // The space must not finish before the block it is vacating has faded.
  const seconds = (name) => Number(foldOut[0].match(new RegExp(`${name}: \\{ duration: ([\\d.]+)`))[1]);
  assert.ok(seconds('opacity') < seconds('height'), 'the fade lands before the space closes');
  assert.ok(seconds('height') - seconds('opacity') <= 0.1, 'and no more than 100ms before it');
  assert.doesNotMatch(foldOut[0], /\[0\.16, 1, 0\.3, 1\]/, 'the collapse must not ride the arrival curve');
  assert.doesNotMatch(foldOut[0], /\[0\.77, 0, 0\.175, 1\]/, 'nor the steep ease-in-out that peaked worse than what it replaced');
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.ehc-wiki-fold \{\s*overflow: hidden;\s*\}/);
  // The constant stands for `--space-4`, the gap `.explorer-hero-content` stacks with.
  const tokens = await read('../../styles/variables.css');
  assert.match(tokens, /--space-4: 1rem;/);
  assert.match(css, /\.explorer-hero-content \{[^}]*gap: var\(--space-4\);/);
});

test('the list mounts in idle chunks, rows below the fold are skipped, and the sentinel waits for the page', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const \[rowBudget, setRowBudget\] = useState\(EXPLORER_ROW_CHUNK\);/);
  assert.match(jsx, /const mountedPapers = useMemo\(\(\) => filteredPapers\.slice\(0, rowBudget\), \[filteredPapers, rowBudget\]\);/);
  assert.match(jsx, /const rowsSettled = rowBudget >= filteredPapers\.length;/);
  assert.match(jsx, /setRowBudget\(\(budget\) => nextExplorerRowBudget\(budget, filteredPapers\.length\)\)/);
  assert.match(jsx, /if \(page === 1\) \{\s*setIsLoadingPapers\(true\);\s*setPapersError\(null\);\s*setRowBudget\(EXPLORER_ROW_CHUNK\);/, 'a fresh page starts over at one chunk');
  assert.match(jsx, /\{hasMore && rowsSettled && \(\s*<div ref=\{observerRef\} className="ehc-sentinel">/);
  assert.match(jsx, /mountedPapers\.map\(\(paper, idx\) => \(/);
  assert.match(jsx, /'--area-accent': rowAreas\[idx\]\.accent/, 'the field colour is derived once per list');
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-list-item \{[^}]*content-visibility: auto;\s*contain-intrinsic-size: auto 200px;[^}]*\}/);
});
