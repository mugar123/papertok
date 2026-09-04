import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for how an entity page opens and how the feed comes back.
 */
test('the explorer paints the name a link handed over before the entity answers', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /const seedName = useMemo\(/);
  assert.match(jsx, /seedName\s*\?\s*<h1 className="ehc-name"[^>]*>\{seedName\}<\/h1>\s*:\s*<div className="ex-skel ex-skel-name"><\/div>/);
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-hero-content\.is-skeleton \{\s*animation: none;\s*\}/, 'the skeleton does not fade on top of the page transition');
  // Two separate guarantees that happen to live on the same element, so they
  // are pinned together: `heroBodyRef` is what measures the entrance, and
  // `aria-hidden` moved here from the `.explorer-hero` container that wraps
  // this block, so the real Back button beside it stays announced while this
  // decorative content does not (axe's `aria-hidden-focus`).
  assert.match(jsx, /<div className="explorer-hero-content is-skeleton" ref=\{heroBodyRef\} aria-hidden="true">/);
});

test('the explorer chunk is preloaded with the other screens a session reaches', async () => {
  const app = await read('../../App.jsx');
  assert.match(app, /EntityExplorer\.preload\(\)\.catch/);
});

test('coming back to the feed resumes it at rest instead of replaying the arrival', async () => {
  const transition = await read('../Layout/PageTransition.jsx');
  assert.match(transition, /data-nav-direction=\{direction\}/);
  const css = await read('../Feed/PaperCard.css');
  assert.match(css, /\[data-nav-direction="-1"\] \.pc-sheet,[\s\S]*?\[data-nav-direction="-1"\] \.pc-side-actions \{\s*animation: none;\s*\}/);
});

test('the hero settles between its heights instead of snapping at the handover', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /import \{ useHeightSettle \} from '\.\.\/\.\.\/hooks\/useHeightSettle';/);
  assert.match(jsx, /const heroBodyRef = useRef\(null\);\s*useHeightSettle\(\s*heroBodyRef,\s*\[isLoadingEntity, entity, orcidInfo, isLoadingOrcid, wikiDescription, isWikiRequestPending, recentImpact, hasLoadedWikiImage\],\s*\{ enabled: !prefersReducedMotion \},\s*\);/);
  // The same ref on the skeleton's body and on the live one: the remembered
  // height belongs to the slot, so the handover between the two is a settle.
  // The body and not the hero, so the tab strip after it moves with the box
  // instead of snapping inside it.
  assert.match(jsx, /<div className="explorer-hero-content is-skeleton" ref=\{heroBodyRef\} aria-hidden="true">/);
  assert.match(jsx, /<div className="explorer-hero-content" ref=\{heroBodyRef\}>/);
  assert.doesNotMatch(jsx, /className="explorer-hero" ref=/, 'the outer hero is not the animated box');
});

test('the height settle is a FLIP on one property, chaining through a settle already running', async () => {
  const hook = await read('../../hooks/useHeightSettle.js');
  assert.match(hook, /useLayoutEffect\(/, 'measured before paint, so the first frame is already the old height');
  assert.match(hook, /el\.animate\(\s*\[\{ height: `\$\{from\}px` \}, \{ height: `\$\{to\}px` \}\],/);
  assert.match(hook, /el\.getAnimations\(\)\.find\(\(animation\) => animation\.id === SETTLE_ID\)/);
  assert.match(hook, /from = el\.getBoundingClientRect\(\)\.height;\s*running\.cancel\(\);/);
  assert.match(hook, /if \(!enabled \|\| from == null \|\| Math\.abs\(to - from\) < 1/, 'no animation on the first measurement or on a change too small to see');
  // Clipped only while moving: the box is smaller than its content on the way
  // down and on the way up, and a project's links menu hangs outside it at rest.
  assert.match(hook, /el\.style\.overflow = 'hidden';/);
  assert.match(hook, /animation\.finished\.then\(release, release\);/);
  assert.match(hook, /if \(el\.getAnimations\(\)\.some\(\(other\) => other\.id === SETTLE_ID\)\) return;/, 'a newer settle keeps the clip');
});

test('the skeleton tab strip stands as tall as the live one', async () => {
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-skeleton \.ee-tabs \{\s*min-height: 40px;\s*align-items: center;\s*\}/);
  assert.match(css, /\.ee-tab \{[^}]*padding: 10px 2px;[^}]*\}/, 'the 40px is the live tab: 10px either side of the label and the 3px rule');
});
