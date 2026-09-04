import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

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
  const squeeze = css.match(/\.entity-follow-btn:active:not\(:disabled\)[\s\S]*?\{([^}]*)\}/);
  assert.ok(squeeze, 'the compact controls share one press rule');
  assert.match(squeeze[1], /transform: scale\(0\.97\);/);

  // Full-bleed rows take a background instead: a 776px serif row scaled by 3%
  // re-rasters two lines of type for a tap.
  const rows = css.match(/\.explorer-list-item:active,\s*\.ee-author-card:active,[\s\S]*?\{([^}]*)\}/);
  assert.ok(rows, 'the rows have their own press rule');
  assert.match(rows[1], /background: var\(--bg-secondary\);/);
  assert.doesNotMatch(rows[1], /transform:/, 'a full-bleed row must not scale');
});

/**
 * `transition` is a shorthand. A later rule naming only `transform` drops the
 * colour fades these controls already declare — the trap `ThemeToggle.css`
 * documents. So `transform` is appended to their lists, never given fresh.
 */
test('the press transition is appended to the lists these controls already had', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  for (const cls of ['ehc-name-toggle', 'project-links-trigger', 'ee-filter-chip', 'ee-tab']) {
    const rule = css.match(new RegExp(`^\\.${cls}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(rule, `${cls} has a base rule`);
    const transition = rule[1].match(/transition:([^;]*);/);
    assert.ok(transition, `${cls} still declares a transition`);
    assert.match(transition[1], /transform 0\.16s ease-out/, `${cls} gained the press`);
    assert.match(transition[1], /color|background/, `${cls} kept what it already faded`);
  }
});

/**
 * The hero's three arrivals all resolve from 0.35 rather than from nothing,
 * because each takes the place of a grey shape of its own size. The prose was
 * written from 0 first, which is the worst case for it: the bars are removed in
 * the same commit, so the block would be genuinely blank for the first frames.
 */
test('the Wikipedia prose resolves from the same 0.35 as every other arrival in the hero', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  const frames = css.match(/@keyframes wikiProseIn\s*\{[\s\S]*?\n\}/);
  assert.ok(frames, 'the prose has an arrival');
  assert.match(frames[0], /from \{ opacity: 0\.35; \}/);
  // The house rule it now follows.
  assert.match(css, /@keyframes slideUpFade \{\s*from \{ opacity: 0\.35; \}/);
  assert.match(css, /@keyframes staggerFadeUp \{\s*0% \{ opacity: 0\.35;/);
});

/**
 * Framer applies the component's `transition` to `exit` unless the exit variant
 * carries its own — so this fold was closing on the arrival's expo-out, the
 * exact shape the Wikipedia fold was measured at -31.9px making. It is the
 * taller of the hero's two folds and the only one a click closes.
 */
test('the ORCID experience panel closes on a curve of its own, not the arrival reversed', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  const foldOut = jsx.match(/const EXPERIENCE_FOLD_OUT = \{[\s\S]*?\n\};/);
  assert.ok(foldOut, 'the panel has a closing transition');
  assert.match(foldOut[0], /opacity: \{ duration: 0\.16, ease: \[0\.4, 0, 1, 1\] \}/);
  assert.match(foldOut[0], /height: \{ duration: 0\.3, ease: \[0\.4, 0, 0\.2, 1\] \}/);
  assert.doesNotMatch(foldOut[0], /\[0\.16, 1, 0\.3, 1\]/, 'the collapse must not ride the arrival curve');
  // And it is actually reached by the exit variant.
  assert.match(jsx, /\{ opacity: 0, height: 0, transition: EXPERIENCE_FOLD_OUT \}/);
});

/**
 * The wash IS the photograph, blurred. It fades off the same flip, so a second
 * of framer's default `easeInOut` left it still deepening 720ms after the
 * picture had settled.
 */
test('the background wash arrives with the photograph it is made of', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  const wash = jsx.match(/animate=\{\{ opacity: 0\.1 \}\}[\s\S]{0,240}?className="ehc-bg-blur"/);
  assert.ok(wash, 'the wash is still there');
  assert.match(wash[0], /duration: 0\.28, ease: \[0\.16, 1, 0\.3, 1\]/);
  assert.match(wash[0], /prefersReducedMotion/, 'and it is branched');
  // The same clock the visual slot's cross-fade runs on.
  const slot = jsx.match(/className="ehc-icon"[\s\S]{0,400}?transition=\{prefersReducedMotion \? \{ duration: 0 \} : \{ duration: ([\d.]+)/);
  assert.ok(slot, 'the tile still declares its own clock');
  assert.equal(slot[1], '0.28', 'wash and photograph share one duration');
});

/**
 * `hasMore` says there is a next page, not that a request is in flight — so an
 * infinite spinner sat at the foot of every list announcing a fetch that had
 * not started. The box itself must stay mounted: it is the observer's target.
 */
test('the sentinels spin only while something is actually loading, and stay mounted regardless', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  // Still the observer's target, unconditionally within its gate.
  assert.match(jsx, /\{hasMore && rowsSettled && \(\s*<div ref=\{observerRef\} className="ehc-sentinel">/);
  assert.match(jsx, /\{isFetchingMore && <Loader2 className="ehc-spinner" size=\{24\} \/>\}/);
  assert.match(jsx, /\{isFetchingMoreAuthors && <Loader2 className="ehc-spinner" size=\{24\} \/>\}/);
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
  assert.doesNotMatch(blanket[0], /\.ee-tab,/, 'the tab keeps its colour fade');
  assert.doesNotMatch(blanket[0], /\.explorer-list-item,/, 'a row keeps its background fade');

  // The press degrades to colour only.
  assert.match(block[0], /\.ee-tab:active:not\(:disabled\) \{\s*transform: none;\s*\}/);
  // And the rows' press background is NOT switched off — it is the point.
  assert.doesNotMatch(block[0], /\.explorer-list-item:active/);
});
