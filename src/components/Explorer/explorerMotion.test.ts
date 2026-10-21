import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for the entity hero's motion, written after an audit of the five
 * entity types found the same complaint from four directions: an author or a
 * project page loads as one fade and then holds perfectly still.
 */

/**
 * Every feedback rule in this file used to sit inside `@media (hover: hover)`,
 * which is right for a hover and useless for a thumb: 2314 lines of stylesheet
 * with not one `:active`, on the most-touched surface in the app.
 */
test('the Explorer acknowledges a press, and on a thumb rather than only a pointer', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.ok(/:active/.test(css), 'the Explorer has press feedback at all');

  // Compact controls take the catalog's scale.
  const squeeze = css.match(/\.ehc-name-toggle:active:not\(:disabled\)[\s\S]*?\{([^}]*)\}/);
  assert.ok(squeeze, 'the compact controls share one press rule');
  assert.match(squeeze[1], /transform: scale\(0\.97\);/);

  // Full-bleed rows take a background instead: a 776px serif row scaled by 3%
  // re-rasters two lines of type for a tap.
  const rows = css.match(/\.explorer-grid > \.list-row:not\(\.ex-skel-row\):active,\s*\.ee-author-card:active,[\s\S]*?\{([^}]*)\}/);
  assert.ok(rows, 'the rows have their own press rule');
  assert.match(rows[1], /background: var\(--bg-secondary\);/);
  assert.doesNotMatch(rows[1], /transform:/, 'a full-bleed row must not scale');
});

/**
 * Framer applies the component's `transition` to `exit` unless the exit variant
 * carries its own — so this fold was closing on the arrival's expo-out, the
 * exact shape the Wikipedia fold was measured at -31.9px making. It is the
 * taller of the hero's two folds and the only one a click closes.
 */
test('the ORCID experience panel closes on a curve of its own, not the arrival reversed', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  const foldOut = jsx.match(/const EXPERIENCE_FOLD_OUT: Transition = \{[\s\S]*?\n\};/);
  assert.ok(foldOut, 'the panel has a closing transition');
  assert.match(foldOut[0], /opacity: \{ duration: 0\.16, ease: 'linear' \}/);
  assert.match(foldOut[0], /height: \{ duration: 0\.3, ease: \[0\.4, 0, 0\.2, 1\] \}/);
  assert.doesNotMatch(foldOut[0], /\[0\.16, 1, 0\.3, 1\]/, 'the collapse must not ride the arrival curve');
  // And it is actually reached by the exit variant.
  assert.match(jsx, /\{ opacity: 0, height: 0, transition: EXPERIENCE_FOLD_OUT \}/);
});

/**
 * `hasMore` says there is a next page, not that a request is in flight — so an
 * infinite spinner sat at the foot of every list announcing a fetch that had
 * not started. The box itself must stay mounted: it is the observer's target.
 */
test('the sentinels spin only while something is actually loading, and stay mounted regardless', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  // Still the observer's target, unconditionally within its gate.
  // `hasMore && rowsSettled` sigue abriendo la puerta; desde el 12-09 lleva
  // además una guarda para no invitar a bajar por una lista vacía, así que
  // aquí se fija el principio de la condición y el destino, no su literal.
  assert.match(jsx, /hasMore && rowsSettled &&[\s\S]{0,80}<div ref=\{observerRef\} className="ehc-sentinel">/);
  assert.match(jsx, /<Petri pose="flask" className=\{isFetchingMore \? 'petri-loader' : undefined\} \/>/);
  assert.match(jsx, /<Petri pose="flask" className=\{isFetchingMoreAuthors \? 'petri-loader' : undefined\} \/>/);
  // And it says something true while it waits.
  assert.match(jsx, /'Scroll for more'/);
});

/**
 * Reduced motion means fewer and gentler animations, not fewer signals. The
 * block used to carry `.ee-tab` and `.explorer-list-item` into a blanket
 * `transition: none`, which took their colour and background fades with the
 * movement.
 */
test('reduced motion drops the movement and keeps the colour', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n/);
  assert.ok(block, 'the Explorer has a reduced-motion block');

  // The blanket group must no longer swallow the two colour-only surfaces.
  const blanket = block[0].match(/\{[\s\S]*?animation: none;\s*transition: none;\s*\}/);
  assert.ok(blanket, 'there is still a blanket group');
  assert.doesNotMatch(blanket[0], /\.explorer-list-item,/, 'a row keeps its background fade');

  // The press degrades to colour only.
  assert.match(block[0], /\.ee-filter-apply:active:not\(:disabled\) \{\s*transform: none;\s*\}/);
  // And the rows' press background is NOT switched off — it is the point.
  assert.doesNotMatch(block[0], /\.explorer-list-item:active/);
});

/**
 * The ORCID experience panel opens BY DEFAULT when a record lands, and it used
 * to mount at `height: 0` under framer's entrance — inside a hero body whose
 * `useHeightSettle` had just measured its `to` in the same commit, 130px
 * short. WAAPI clamped the box for 360ms while framer grew the panel within it,
 * and the box snapped +130px the frame the settle let go. Measured on a phone
 * opening an author from the feed: the hero went up 64, down 138, then jumped
 * 130 in a single frame. One box, one owner: on arrival the panel mounts at
 * full height and the settle carries it; framer's entrance is for the toggle.
 */
test('the ORCID experience panel mounts at full height on arrival and animates only for the toggle', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /const \[experienceToggled, setExperienceToggled\] = useState(?:<[^;\n]+>)?\(false\);/);
  // The load owns the reset; a deferred overlay reset must not erase it.
  assert.match(jsx, /setIsLoadingOrcid\(type === 'author' && Boolean\(\(bornWith as ExplorerEntity \| null\)\?\.orcid \|\| extractOrcid\(id\)\)\);\s*setIsExperienceOpen\(true\);\s*setExperienceToggled\(false\);/);
  // The reader's own press is what earns the entrance.
  assert.match(jsx, /onClick=\{\(\) => \{ setExperienceToggled\(true\); setIsExperienceOpen\(open => !open\); \}\}/);
  // On arrival the panel mounts at full height (the settle carries the space)
  // and fades in (the words arrive): opacity does not touch layout, so the
  // height keeps a single owner. `initial={false}` used to switch the fade
  // off with the height — the bordered panel popped in at opacity 1.
  assert.match(jsx, /initial=\{experienceToggled \? \(prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, height: 0 \}\) : \{ opacity: 0 \}\}/);
});

/**
 * The hero body's settle carries everything under the hero — the tab strip,
 * the list. On the hook's expo-out default a phone spent a quarter of an ORCID
 * arrival in one frame; the gentle ease-in-out spreads it, and it is the same
 * curve the Wikipedia fold's collapse measured its way onto.
 */
test('the hero body settles on a curve that lands, not the arrival curve', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  const call = jsx.match(/useHeightSettle\(\s*heroBodyRef,[\s\S]*?\);/);
  assert.ok(call, 'the hero body is settled');
  assert.match(call[0], /easing: 'cubic-bezier\(0\.4, 0, 0\.2, 1\)'/);
  assert.doesNotMatch(call[0], /0\.16, 1, 0\.3, 1/, 'the settle must not ride the expo-out');
});

/**
 * `useHeightSettle` pins the hero body's height with a Web Animation. A flex
 * column with a definite height smaller than its content shrinks the items
 * whose automatic minimum size is 0 — exactly the ones with `overflow:
 * hidden`: the experience panel, the Wikipedia fold, the wiki block. Measured
 * on ORCID's arrival: the panel laid out at 0px for the first 117ms of a
 * 360ms settle, its inner 136px the whole time, then grew 0→152 in the tail
 * and shoved the card that had already landed.
 */
test('nothing in the hero body gives way to the settle', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.match(css, /\.explorer-hero-content > \* \{\s*flex-shrink: 0;\s*\}/);
});

/**
 * The project summary box carried `layout` too. The hero body's settle
 * already animates the space; the projection was a second owner of the same
 * height, and it scaled three lines of serif when the "Read more" toggle
 * mounted a frame after the text.
 */
test('the project summary box is a plain block; the settle owns its height', async () => {
  const jsx = stripComments(await read('./EntityExplorer.tsx'));
  assert.match(jsx, /\{type === 'project' && entity\?\.summary && \(\s*<div\s+className=\{`project-summary-box/);
  const box = jsx.match(/<div\s+className=\{`project-summary-box[\s\S]*?<\/div>\s*\)\}/);
  assert.ok(box, 'the summary box is still rendered');
  assert.doesNotMatch(box[0], /\blayout\b/);
  assert.doesNotMatch(box[0], /transition=/);
});

/**
 * The panel opens by default when the record lands (2026-09-04). Measured on
 * an author with a long history: 590px of panel, the tab strip pushed 1108px
 * in 710ms. Past a few rows the panel arrives folded, and the chevron by the
 * name opens it on the reader's own press.
 */
test('the experience panel arrives open only when it is short', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /const EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS = 4;/);
  assert.match(jsx, /setOrcidInfo\(record\);\s*setIsExperienceOpen\(\(record\?\.employments\?\.length \?\? 0\) <= EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS\);/);
});

/**
 * The skeleton's sweep is constant motion in a loop, and constant motion is
 * `linear`. On an `ease-in-out` a loop stalls at both ends and runs fast
 * through the middle, so the sweep read as a pulse rather than as a pass —
 * a heartbeat under a page that is waiting, which is the opposite of what a
 * shimmer is for.
 */
test('the skeleton sweeps at a constant speed, because it never starts or stops', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  const sweeps = [...css.matchAll(/animation: exSkelSweep ([\d.]+s) (\S+) infinite;/g)];
  assert.ok(sweeps.length >= 2, 'both the shapes and the summary lines carry the sweep');
  for (const [, , easing] of sweeps) {
    assert.equal(easing, 'linear', 'a looping sweep must not ease at its ends');
  }
});

/**
 * A delay longer than the wait it decorates is an animation that never runs.
 * Measured 2026-09-07 with a real session: the skeleton stands 418ms on the
 * fast id-keyed author route, and the ladder reached 1.08s — the last two rows
 * never swept once. The wave still walks down the page, on a 30ms step
 * throughout instead of 60 and 120 at the bottom.
 */
test('no shape waits longer for its turn than the skeleton is on screen', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  const ladder = [...css.matchAll(/\.explorer-skeleton [^{]*::after \{ animation-delay: ([\d.]+)s; \}/g)]
    .map(([, seconds]) => Number(seconds));
  assert.ok(ladder.length >= 15, `the ladder is still there, got ${ladder.length} steps`);
  const longest = Math.max(...ladder);
  assert.ok(longest <= 0.5, `no step may outlive the skeleton's own 418ms wait by much; longest is ${longest}s`);
});

