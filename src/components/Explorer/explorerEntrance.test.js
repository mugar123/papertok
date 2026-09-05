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
  // Comments are prose, not code: the call carries a comment between its
  // dependency list and its options, and this must read through it.
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{ useHeightSettle \} from '\.\.\/\.\.\/hooks\/useHeightSettle';/);
  assert.match(jsx, /const heroBodyRef = useRef\(null\);\s*useHeightSettle\(\s*heroBodyRef,\s*\[isLoadingEntity, entity, orcidInfo, isLoadingOrcid, wikiDescription, isWikiRequestPending, recentImpact, hasLoadedWikiImage\],\s*\{ enabled: !prefersReducedMotion, easing: 'cubic-bezier\(0\.4, 0, 0\.2, 1\)' \},\s*\);/);
  // The easing is passed here, not changed in the hook: the hook's expo-out
  // default is right for a box that appears, and this is the one box whose
  // growth moves everything beneath it. Measured on a phone opening an author:
  // the expo-out spent 26% of an ORCID arrival in a single frame (35px of 134,
  // 70px of 268 at a quarter of the CPU); the ease-in-out halved that share
  // (34px of 268) and took the skeleton settle from a 17px worst step to 8.
  // The same reasoning, and the same curve, as WIKI_FOLD_OUT.
  // The same ref on the skeleton's body and on the live one: the remembered
  // height belongs to the slot, so the handover between the two is a settle.
  // The body and not the hero, so the tab strip after it moves with the box
  // instead of snapping inside it.
  assert.match(jsx, /<div className="explorer-hero-content is-skeleton" ref=\{heroBodyRef\} aria-hidden="true">/);
  assert.match(jsx, /<div className="explorer-hero-content" ref=\{heroBodyRef\}>/);
  assert.doesNotMatch(jsx, /className="explorer-hero" ref=/, 'the outer hero is not the animated box');
});

test('the height settle is a FLIP on one property, decided every commit and re-aimed in flight', async () => {
  const hookRaw = await read('../../hooks/useHeightSettle.js');
  const hook = hookRaw.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(hook, /import \{ depsAreSame, planHeightSettle \} from '\.\/heightSettlePlan\.js';/);
  // Measured before paint, so the first frame is already the old height —
  // and with NO dependency list: the memory is kept on every commit.
  assert.match(hook, /useLayoutEffect\(\(\) => \{/);
  assert.match(hook, /\n {2}\}\);\n\}\n$/, 'the effect closes without a dependency array');
  assert.doesNotMatch(hookRaw, /eslint-disable-next-line react-hooks\/exhaustive-deps/);
  // A settle in flight is read (keyframes and clock) before it is cancelled.
  assert.match(hook, /el\.getAnimations\(\)\.find\(\(animation\) => animation\.id === SETTLE_ID\)/);
  assert.match(hook, /const \[start, end\] = inFlight\.effect\.getKeyframes\(\);/);
  assert.match(hook, /current = el\.getBoundingClientRect\(\)\.height;\s*inFlight\.cancel\(\);/);
  // The decision is the pure module's; the hook only measures and drives.
  assert.match(hook, /const plan = planHeightSettle\(\{ remembered: lastHeightRef\.current, depsChanged, running, current, natural \}\);/);
  assert.match(hook, /lastHeightRef\.current = plan\.remember;/);
  assert.match(hook, /el\.animate\(\s*\[\{ height: `\$\{plan\.from\}px` \}, \{ height: `\$\{plan\.to\}px` \}\],/);
  assert.match(hook, /if \(plan\.action === 'resume'\) animation\.currentTime = plan\.currentTime;/);
  // Clipped only while moving; a newer settle keeps the clip.
  assert.match(hook, /el\.style\.overflow = 'hidden';/);
  assert.match(hook, /animation\.finished\.then\(release, release\);/);
  assert.match(hook, /if \(el\.getAnimations\(\)\.some\(\(other\) => other\.id === SETTLE_ID\)\) return;/, 'a newer settle keeps the clip');
});

test('the skeleton tab strip stands as tall as the live one', async () => {
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer-skeleton \.ee-tabs \{\s*min-height: 40px;\s*align-items: center;\s*\}/);
  assert.match(css, /\.ee-tab \{[^}]*padding: 10px 2px;[^}]*\}/, 'the 40px is the live tab: 10px either side of the label and the 3px rule');
});

test('the explorer is born with the entity a link handed over, and treats its own fetch as an upgrade', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{ useParams, useNavigate, useSearchParams, useLocation \} from 'react-router-dom';/);
  assert.match(jsx, /import \{ handedEntityFor \} from '\.\.\/\.\.\/utils\/explorerHandover\.js';/);
  assert.match(jsx, /const handedEntity = useMemo\(\(\) => handedEntityFor\(type, id, location\.state\), \[id, location\.state, type\]\);/);
  assert.match(jsx, /const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/);
  // The load never puts a handed page back into the skeleton.
  assert.match(jsx, /if \(handedEntity\) \{\s*setEntity\(handedEntity\);\s*setIsLoadingEntity\(false\);\s*\} else \{\s*setIsLoadingEntity\(true\);\s*setEntity\(null\);\s*\}/);
  assert.match(jsx, /setEntity\(data \|\| handedEntity\);/);
  assert.match(jsx, /\}, \[type, id, searchParams, entityReloadKey, handedEntity\]\);/);
});
