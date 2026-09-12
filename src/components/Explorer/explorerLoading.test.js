import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

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
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(jsx, /WikiBlockSkeleton/, "explorerSkeletonShape never answers 'wiki' any more, so the component was unreachable");
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.doesNotMatch(css, /\.ehc-wiki--reserved/);
  assert.doesNotMatch(css, /\.explorer-skeleton \.ehc-wiki-skeleton span:nth-child\(5\)/, 'no skeleton under the page skeleton has a fifth span (the in-block rows of a re-lookup do, and keep theirs)');
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
  assert.match(css, /\.orcid-career-section--animate > \* \{\s*animation:\s*authorContentFade 0\.36s linear backwards,\s*authorContentTravel 0\.42s var\(--ease-out-quad\) backwards;\s*\}/);
  assert.match(css, /\.orcid-career-section--animate > \.orcid-career-header \{\s*animation: authorContentFade 0\.36s linear backwards;\s*\}/, 'the badge resolves in place');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.orcid-career-section--animate > \.orcid-career-header,/);
  assert.match(reduced, /\.ehc-experience-panel \.orcid-timeline-item,/);
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
  assert.match(jsx, /setEntity\(data \|\| handedEntity \|\| cachedEntity\);\s*setIsLoadingEntity\(false\);[\s\S]*?setIsLoadingOrcid\(wantsOrcid\);[\s\S]*?await Promise\.all\(\[\s*wantsRecentImpact \? loadRecentImpact\(\) : null,\s*wantsOrcid \? loadOrcid\(\) : null,\s*\]\);/);
});

test('a known ORCID keeps its loading slot and a deferred reset cannot clear its response', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /useState\(\(\) => type === 'author' && Boolean\(entity\?\.orcid \|\| extractOrcid\(id\)\)\)/);
  assert.match(jsx, /setIsLoadingOrcid\(type === 'author' && Boolean\(bornWith\?\.orcid \|\| extractOrcid\(id\)\)\);/);
  const reset = jsx.match(/useEffect\(\(\) => \{\s*const timer = setTimeout\(\(\) => \{\s*setSelectedPaper\(null\);([\s\S]*?)\}, \[type, id\]\);/);
  assert.ok(reset, 'the overlay reset is cancellable');
  assert.doesNotMatch(reset[1], /setOrcidInfo|setIsLoadingOrcid|setIsExperienceOpen|setExperienceToggled/,
    'a fast ORCID response survives the next timer task');
  assert.match(reset[1], /return \(\) => clearTimeout\(timer\);/);
  assert.match(jsx, /setEntityError\('ENTITY_LOAD_FAILED'\);\s*setIsLoadingEntity\(false\);\s*setIsLoadingOrcid\(false\);/,
    'a failed entity refresh releases the waiting slot');
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.explorer-container--author \.explorer-hero-content \{\s*animation: none;\s*\}/,
    'the column does not multiply the opacity of the arriving career blocks');
});

/**
 * The block arrives rather than appears, and the hero's settle is what carries
 * its space. It mounts once its lookup has settled with everything it is
 * going to have, its CONTENTS fade in, and the box grows under the settle's clip —
 * the same arrival the ORCID card and the experience panel already make. For
 * two days (3b96b3a → aea5a59) the fold animated its own `height: 'auto'` and
 * the settle stood down behind a latch; measured 2026-09-09, that latch, its
 * re-sync and its hand-over branch were the bug (a snapped handover on every
 * navigation, a mid-exit height animated from, a homepage-only block left
 * clamped). One owner of the height, and it is not framer.
 */
test('the Wikipedia block arrives under the settle: its fold animates opacity only', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  const fold = jsx.match(/<motion\.div\s+className="ehc-wiki-fold"([\s\S]*?)>\s*<div\s+className=\{`ehc-wiki /);
  assert.ok(fold, 'the fold is a motion wrapper around the padded `.ehc-wiki`');
  assert.match(fold[1], /initial=\{\{ opacity: 0 \}\}/, 'it starts invisible, at its full height');
  assert.match(fold[1], /animate=\{\{ opacity: 1 \}\}/);
  assert.match(fold[1], /exit=\{prefersReducedMotion \? \{ opacity: 0, transition: \{ duration: 0 \} \} : \{ opacity: 0, transition: \{ duration: 0\.15 \} \}\}/, 'it leaves the way it came, quickly — the settle closes the space after it — and reduced motion cuts that exit too, like its sibling folds');
  assert.doesNotMatch(fold[1], /height/, 'framer never touches the height: the settle owns it');
  assert.doesNotMatch(fold[1], /marginTop|\by:/, 'nor the margin or a translate: nothing here moves layout');
  assert.doesNotMatch(fold[1], /onAnimationStart|onAnimationComplete|layout/, 'no latch, no projection');
  assert.doesNotMatch(jsx, /wikiFoldAnimatingRef|WIKI_FOLD_OUT|HERO_STACK_GAP_PX/, 'and nothing is left of the second owner');
});

/**
 * Once open, the block stays open across a RE-lookup. `wikiRequestKey` carries
 * the language and the localized name, so switching the app language on an
 * institution (or a localized name landing late) starts a new lookup; gated on
 * `!isWikiRequestPending` alone, that unmounted the block — a 480ms fold-out,
 * the list rising — and mounted it again when the new paragraph came. Reported
 * and reproduced 2026-09-09. Open once with content, the block holds its rows
 * while the new lookup is out and swaps them for the prose in place, which is
 * what the pre-3b96b3a code did and what the in-fold skeleton branch is for.
 */
test('the Wikipedia block opens once, and a re-lookup swaps its contents in place', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(jsx, /const \[wikiBlockOpened, setWikiBlockOpened\] = useState\(false\);/);
  // Adjusted during render — the documented way to derive state from a prop —
  // so the commit that settles with content is the one that opens the block.
  assert.match(
    jsx,
    /const wikiHasContent = Boolean\(wikiDescription \|\| entity\?\.homepage_url\);\s*if \(!isWikiRequestPending && wikiHasContent && !wikiBlockOpened\) setWikiBlockOpened\(true\);/,
  );
  assert.match(jsx, /const showWikiBlock = wikiBlockOpened && \(wikiHasContent \|\| isWikiRequestPending\);/,
    'held open through a re-lookup, and closed only when a settled lookup finds nothing');
  // Per entity, from closed: the next page's first lookup opens it again.
  const reset = jsx.match(/setWikiInfo\(null\);([\s\S]{0,400})/);
  assert.ok(reset && /setWikiBlockOpened\(false\);/.test(reset[1]), 'reset with the rest of the wiki state when the entity changes');
  assert.match(jsx, /\{isWikiRequestPending \? \(\s*<div className="ehc-wiki-skeleton" role="status"/, 'the rows inside the block are what a re-lookup shows');
});

/**
 * The fold's removal is `AnimatePresence`'s own state update and never reaches
 * this component, so without a commit at that moment the ~155px the block held
 * drops in an unanimated reflow after its fade — the failure this whole change
 * exists to remove, arriving from the exit side. `onExitComplete` is that commit.
 */
test('the space the Wikipedia block leaves behind is closed by the settle, not dropped', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /const \[wikiFoldExits, setWikiFoldExits\] = useState\(0\);/);
  assert.match(jsx, /<AnimatePresence initial=\{false\} onExitComplete=\{\(\) => setWikiFoldExits\(\(n\) => n \+ 1\)\}>/);
  const deps = jsx.match(/useHeightSettle\(\s*heroBodyRef,\s*\[([^\]]*)\]/);
  assert.ok(deps, 'the settle declares what is worth a movement');
  assert.match(deps[1], /\bwikiFoldExits\b/, 'and the fold leaving is one of them');
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
 * With the settle owning the space, the fold's wrapper has nothing to clip: the
 * hero body clips while it grows. A leftover `overflow: hidden` on the wrapper
 * would only cut the paragraph's own "Read more" transition.
 */
test('the fold wrapper is a plain box now', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.doesNotMatch(css, /\.ehc-wiki-fold \{/, 'no rule of its own');
});

test('the list mounts in idle chunks, rows below the fold are skipped, and the sentinel waits for the page', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const \[rowBudget, setRowBudget\] = useState\(EXPLORER_ROW_CHUNK\);/);
  assert.match(jsx, /const mountedPapers = useMemo\(\(\) => filteredPapers\.slice\(0, rowBudget\), \[filteredPapers, rowBudget\]\);/);
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
  assert.match(jsx, /const visiblePapers = useMemo\(\(\) => guestPreviewRows\(mountedPapers, \{ publicMode \}\)/);
  assert.match(jsx, /visiblePapers\.map\(\(paper, idx\) => \(/);
  assert.match(jsx, /'--area-accent': rowAreas\[idx\]\.accent/, 'the field colour is derived once per list');
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-list-item \{[^}]*content-visibility: auto;\s*contain-intrinsic-size: auto 200px;[^}]*\}/);
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
  const src = stripComments(await read('./EntityExplorer.jsx'));

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

/**
 * A project's first page can take close to 17s in the worst case — OpenAIRE's
 * own 10s budget, then arXiv enrichment and DOI lookups inside
 * ENTITY_PRIMARY_RENDER_BUDGET_MS's 7s — with nothing on screen but the five
 * skeleton rows and no word said about what is being waited on. Announced
 * only once the wait has run past 4s, so a normal load never shows it.
 */
test('the first page\'s long wait is announced at 4s, in a fade, under the skeleton rows', async () => {
  const src = stripComments(await read('./EntityExplorer.jsx'));
  const css = await read('./EntityExplorer.css');
  assert.match(src, /setTimeout\(\(\) => setIsPapersLoadSlow\(true\), 4000\)/);
  assert.match(src, /isLoadingPapers && !isFetchingMore && isPapersLoadSlow && \(\s*<p className="explorer-loading-note"/);
  assert.match(css, /\.explorer-loading-note \{[^}]*animation: slideUpFade/s);
});

/**
 * `react-hooks/set-state-in-effect` flags a synchronous setState in an
 * effect body; the timer effect's first shape guarded itself with
 * `if (!(...)) { setIsPapersLoadSlow(false); return undefined; }`, which is
 * exactly that, and was the one lint error in the whole repo. The reset now
 * lives in `loadPapers`'s page-1 branch instead, an async function the
 * linter does not trace into, so the effect's own body has nothing left for
 * the rule to catch — it only starts a timeout and clears it. Re-armed by
 * route too: `type`/`id` are in the dependency array, so navigating from one
 * slow-loading project straight into another restarts the four-second clock
 * instead of inheriting whatever was left of the first one's.
 */
test('the timer effect only arms the wait; it never resets the flag inside its own body', async () => {
  const src = stripComments(await read('./EntityExplorer.jsx'));
  const effect = src.match(/if \(!\(isLoadingPapers && !isFetchingMore\)\) return undefined;[\s\S]*?\}, \[isLoadingPapers, isFetchingMore, type, id\]\);/);
  assert.ok(effect, 'the timer effect guards with a plain return, and is keyed to the route as well');
  assert.doesNotMatch(effect[0], /setIsPapersLoadSlow\(false\)/, 'the reset belongs to loadPapers, not to this effect');
});
