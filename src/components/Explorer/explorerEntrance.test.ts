import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for how an entity page opens and how the feed comes back.
 */
test('the explorer paints the name a link handed over before the entity answers', async () => {
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /const seedName = useMemo(?:<[^;\n]+>)?\(/);
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
  const app = await read('../../App.tsx');
  assert.match(app, /EntityExplorer\.preload\(\)\.catch/);
});

test('coming back to the feed resumes it at rest instead of replaying the arrival', async () => {
  const transition = await read('../Layout/PageTransition.tsx');
  assert.match(transition, /data-nav-direction=\{present \? direction : arrivedWith\}/);
  const css = await read('../Feed/PaperCard.css');
  assert.match(css, /:is\(\[data-nav-direction="-1"\], \[data-nav-lateral="true"\]\) \.pc-sheet,[\s\S]*?:is\(\[data-nav-direction="-1"\], \[data-nav-lateral="true"\]\) \.pc-side-actions \{\s*animation: none;\s*\}/);
});

test('the hero settles between its heights instead of snapping at the handover', async () => {
  // Comments are prose, not code: the call carries a comment between its
  // dependency list and its options, and this must read through it.
  const jsx = (await read('./EntityExplorer.tsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{ useHeightSettle \} from '\.\.\/\.\.\/hooks\/useHeightSettle\.ts';/);
  // `suspended` is the route transition's own gate: a settle under a page that
  // is still travelling is a second owner of the same displacement.
  assert.match(jsx, /const heroBodyRef = useRef(?:<[^;\n]+>)?\(null\);[\s\S]*?useHeightSettle\(\s*heroBodyRef,\s*\[isLoadingEntity, entity, orcidInfo, isLoadingOrcid, recentImpact, hasLoadedWikiImage\],\s*\{ enabled: !prefersReducedMotion, suspended: isPageArriving, easing: 'cubic-bezier\(0\.4, 0, 0\.2, 1\)' \},\s*\);/);
  // The easing is passed here, not changed in the hook: the hook's expo-out
  // default is right for a box that appears, and this is the one box whose
  // growth moves everything beneath it. Measured on a phone opening an author:
  // the expo-out spent 26% of an ORCID arrival in a single frame (35px of 134,
  // 70px of 268 at a quarter of the CPU); the ease-in-out halved that share
  // (34px of 268) and took the skeleton settle from a 17px worst step to 8.
  // The same reasoning, and the same curve, as EXPERIENCE_FOLD_OUT's height.
  // The same ref on the skeleton's body and on the live one: the remembered
  // height belongs to the slot, so the handover between the two is a settle.
  // The body and not the hero, so the tab strip after it moves with the box
  // instead of snapping inside it.
  assert.match(jsx, /<div className="explorer-hero-content is-skeleton" ref=\{heroBodyRef\} aria-hidden="true">/);
  assert.match(jsx, /<div className="explorer-hero-content" ref=\{heroBodyRef\}>/);
  assert.doesNotMatch(jsx, /className="explorer-hero" ref=/, 'the outer hero is not the animated box');
});

test('the explorer is born with the entity a link handed over, and treats its own fetch as an upgrade', async () => {
  const jsx = (await read('./EntityExplorer.tsx')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{ useParams, useNavigate, useSearchParams, useLocation \} from 'react-router-dom';/);
  assert.match(jsx, /import \{ handedEntityFor, handoverFromSearchRow \} from '\.\.\/\.\.\/utils\/explorerHandover\.ts';/);
  assert.match(jsx, /const handedEntity = useMemo(?:<[^;\n]+>)?\(\(\) => handedEntityFor\(type, id, location\.state\), \[id, location\.state, type\]\);/);
  assert.match(jsx, /const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| Boolean\(cachedEntity\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState(?:<[^;\n]+>)?\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| cachedEntity \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/);
  // The load never puts a handed or cached page back into the skeleton.
  assert.match(jsx, /const bornWith = handedEntity \|\| cachedEntity;\s*if \(bornWith\) \{\s*setEntity\(bornWith\);\s*setIsLoadingEntity\(false\);\s*\} else \{\s*setIsLoadingEntity\(true\);\s*setEntity\(null\);\s*\}/);
  assert.match(jsx, /setEntity\(data \|\| handedEntity \|\| cachedEntity\);/);
  assert.match(jsx, /\}, \[type, id, searchParams, entityReloadKey, handedEntity, cachedEntity\]\);/);
});

/**
 * `getEntityById` can throw with no network at all (its ROR path does), well
 * after a handed entity is already painted on screen. The success exit two
 * lines up already guards this (`setEntity(data || handedEntity)`); the
 * catch below used to null the entity out unconditionally, so a throw
 * replaced a hero the reader was already looking at with the full-viewport
 * `.explorer-error` (the `if (!entity)` gate a little further down renders
 * it whenever `entity` is falsy). A page reached any other way — no
 * handover — still falls back to `null` and the error screen, which is
 * correct: there is genuinely nothing to show.
 */
test('a thrown fetch keeps the hero the palette already painted, instead of demolishing it', async () => {
  const jsx = (await read('./EntityExplorer.tsx')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(jsx, /loadEntity\(\)\.catch\(error => \{\s*if \(isCancelled\) return;\s*console\.error\('Failed to load entity', error\);\s*setEntity\(handedEntity \|\| cachedEntity \|\| null\);\s*setEntityError\('ENTITY_LOAD_FAILED'\);\s*setIsLoadingEntity\(false\);\s*setIsLoadingOrcid\(false\);\s*\}\);/);
});

test('an entity already in the persistent cache is born resolved, like one handed over from the palette', async () => {
  const jsx = (await read('./EntityExplorer.tsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{[^}]*\bpeekEntity\b[^}]*\} from '\.\.\/\.\.\/services\/openAlexService/);
  assert.match(jsx, /const cachedEntity = useMemo(?:<[^;\n]+>)?\(\(\) => peekEntity\(type, id\), \[id, type\]\);/);
  assert.match(jsx, /const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| Boolean\(cachedEntity\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState(?:<[^;\n]+>)?\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| cachedEntity \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/,
    'the handed entity still wins — it is the fresher of the two');
});

/**
 * The four blocks the project details fill in land in one frame, on a hero the
 * reader is already looking at. They used to land at full opacity with no ramp
 * of any kind, which is what "everything at once" feels like.
 */
test('the blocks a project fills in rise in sequence instead of landing in one frame', async () => {
  const css = await read('./EntityExplorer.css');

  // From nothing, because these three land where there was nothing. 0.35 is
  // for a row resolving into a shape of its own size, which they are not.
  assert.match(
    css,
    /@keyframes projectBlockIn \{\s*from \{ opacity: 0; transform: translateY\(8px\); \}\s*to \{ opacity: 1; transform: translateY\(0\); \}\s*\}/,
    'the entrance rises from nothing',
  );

  const group = css.match(/^\.project-participants \{[^}]*\}/m)?.[0] || '';
  // `backwards`, never a forwards fill. Measured in the page: a filling
  // animation leaves the computed transform at `matrix(1, 0, 0, 1, 0, 0)` —
  // an identity matrix, not `none`, whatever the last keyframe says — and that
  // makes `.project-participants` a containing block for the framer `layout`
  // grid inside it, whose projection measures against its ancestors.
  assert.match(group, /animation: projectBlockIn 0\.32s cubic-bezier\(0\.4, 0, 0\.2, 1\) backwards;/);
  assert.doesNotMatch(group, /\b(both|forwards)\b/, 'no forwards fill: it would strand a transform');

  // Staggered down the page. The claim is the ORDER, not the numbers: each
  // block waits longer than the one above it, so the group reads as one pass
  // rather than as four things appearing together.
  const delayOf = (selector: string) => {
    const rule = css.match(new RegExp(`\\.${selector} \\{ animation-delay: ([0-9.]+)s; \\}`));
    return rule ? Number(rule[1]) : 0;
  };
  const summary = css.match(/\.project-summary-box \{[\s\S]*?animation-delay: ([0-9.]+)s;/)?.[1];
  assert.ok(summary, 'the summary box waits its turn too');
  assert.ok(
    Number(summary) < delayOf('project-participants'),
    'the summary comes before the organisations',
  );

  // The summary box is the one with a skeleton underneath it, so it resolves in
  // place from 0.35 rather than arriving from nothing.
  assert.match(
    css,
    /\.project-summary-box \{[\s\S]*?animation: staggerFadeUp 0\.32s cubic-bezier\(0\.4, 0, 0\.2, 1\) backwards;/,
    'the reserved block resolves rather than arrives',
  );

  // The rest of what the details fill in, above the four blocks: the stat cells
  // and the link menu. Opacity only and from 0.35, because both sit inside a
  // header that never went away — they sharpen rather than arrive.
  assert.match(
    css,
    /\.explorer-container--project \.ehc-stat-box,\s*\.project-links-menu \{\s*animation: statSettle 0\.32s cubic-bezier\(0\.4, 0, 0\.2, 1\) backwards;\s*\}/,
    'the header pieces fill in too',
  );
  // The hook they are scoped by. Without the type on the live container this
  // would reach every entity page's stats.
  const jsx = await read('./EntityExplorer.tsx');
  assert.match(jsx, /className=\{`explorer-container explorer-container--\$\{type \|\| 'entity'\}\$\{appChromeClass\}`\}/);

  // Reduced motion lands them instantly. The height settle they arrive inside
  // is switched off under the same query (`enabled: !prefersReducedMotion`).
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const selector of ['.project-participants', '.project-summary-box,', '.explorer-container--project .ehc-stat-box', '.project-links-menu']) {
    assert.ok(reduced.includes(selector), `${selector} stops animating under reduced motion`);
  }
});
