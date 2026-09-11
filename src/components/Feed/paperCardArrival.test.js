import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
/** Comments quote the very code these tests pin, so they are stripped first. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * SOURCE test for the side rail on a phone. Below 900px the rail is absolute
 * at `top: 50%` and centred by pulling itself up half its height. That pull
 * was a `transform`, and `pcArrive` — the arrival every piece of the card
 * plays — animates `transform` too: for the 0.55 s of the arrival the
 * animation's value replaced the centring, the rail sat half its height too
 * low (measured on 390×844: top 456 → 448 during the run, 288 the frame it
 * ended), and it jumped up when the animation released the property. The
 * centring is the individual `translate` property now, which the animated
 * `transform` composes with instead of replacing.
 */
test('the mobile side rail is centred with `translate`, so the arrival animation cannot displace it', async () => {
  const css = await read('./PaperCard.css');
  const mobile = css.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/)?.[0] || '';
  const rule = mobile.match(/\.pc-side-actions \{[^}]*\}/)?.[0] || '';
  assert.ok(rule, 'the mobile rail rule exists');
  assert.match(rule, /top: 50%;/);
  assert.match(rule, /translate: 0 -50%;/);
  assert.doesNotMatch(rule, /transform:/);
  // The arrival still animates `transform`, which is why the two must not share it.
  assert.match(css, /@keyframes pcArrive \{\s*0% \{ opacity: 0; transform: translateY\(8px\); \}/);
});

/**
 * SOURCE test for the jolt in the middle of the arrival on a phone.
 *
 * The toggle under the abstract ("Read full abstract") is shown only once the
 * panel is known to be hiding words, and that verdict is a measurement: it
 * cannot be taken before the panel has been given a height, so it lands a
 * couple of frames after the card mounts. The sheet's column is
 * bottom-anchored on a phone (`justify-content: flex-end` under 900px), so
 * the button did not appear under the abstract — it pushed the abstract, the
 * authors, the title and the kicker 25 px up, in a single frame, while those
 * pieces were still fading in at half opacity. Measured at 390x844 through a
 * tab switch: the title's top went 416 -> 383 between two frames, against
 * 14-16 px of smooth travel for the whole arrival on a desktop, where a wider
 * column usually leaves the abstract unclipped and the button never appears.
 *
 * The button's box is on the card from the first frame now, whatever the
 * verdict turns out to be, and the verdict only fades the label in. Nothing
 * moves, and the panel's room no longer depends on the answer — measuring it
 * before paint would have fixed the jolt too, but it forced a synchronous
 * layout on every card the mount window grows into: three tasks of 50-56 ms
 * at 4x CPU on a switch back to For You, where there had been none.
 */
test('the abstract toggle keeps its place from the first frame, so the arrival plays over a still layout', async () => {
  const jsx = await read('./PaperCard.jsx');
  // Rendered for every abstract; the verdict picks the modifier, not the mount.
  assert.match(jsx, /\{abstractText && \(\s*<button\s+type="button"\s+className=\{`pc-abstract-toggle\$\{abstractClipped === true \|\| expanded \? '' : ' pc-abstract-toggle--reserved'\}`\}/);
  const css = await read('./PaperCard.css');
  assert.match(css, /\.pc-abstract-toggle--reserved \{[^}]*visibility: hidden;[^}]*\}/);
  assert.match(css, /\.pc-abstract-toggle \{[^}]*transition: opacity 0\.2s ease-out;[^}]*\}/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
  assert.ok(reduced.some((block) => /\.pc-abstract-toggle[\s\S]*?transition: none;/.test(block)), 'reduced motion drops the fade');
});

/**
 * The project badge arrives async and opens its own space over the title of
 * a card being read. It used to take 900ms (a 450ms height, then the badge on
 * `y`/`scale` after a 300ms delay), then 200ms on the strong expo-out
 * curve -- which put three quarters of the 37px opening into its first three
 * frames (measured 10, 9.6 and 7.9px per frame) and showed the badge at half
 * opacity on the first, over a title that had not yet moved: the title read
 * as shoved down. Nobody asked for this space, so it opens on the curve the
 * app moves pages with (`--ease-out-quad`, 3.6px per frame at most) over the
 * arrival's own 320ms, and the badge fades in on the compositor once the
 * space is 60% open (120ms), landing together with it.
 */
test('the project badge opens its space gently over 320ms, and arrives once the space is mostly open', async () => {
  const jsx = await read('./PaperCard.jsx');
  const slot = jsx.match(/className="pc-project-badge-slot"[\s\S]*?className="pc-project-badge-motion"[\s\S]*?>\s*<button/);
  assert.ok(slot, 'the badge slot and its motion wrapper are still there');
  // Anchored to the outer slot alone, so the inner motion's literal cannot
  // stand in for it.
  const outerSlot = jsx.match(/className="pc-project-badge-slot"[\s\S]*?<div className="pc-project-badge-slot-inner">/)?.[0] || '';
  assert.match(outerSlot, /: \{ duration: 0\.32, ease: \[0\.25, 0\.46, 0\.45, 0\.94\] \}\}/, 'the slot opens over 320ms on the ease-out-quad token');
  assert.doesNotMatch(outerSlot, /delay:/, 'the space starts opening at once');
  const inner = slot[0].slice(slot[0].indexOf('className="pc-project-badge-motion"'));
  assert.match(inner, /initial=\{prefersReducedMotion\s*\?\s*false\s*:\s*\{ opacity: 0, transform: 'translateY\(6px\)' \}\}/);
  assert.match(inner, /animate=\{\{ opacity: 1, transform: 'translateY\(0px\)' \}\}/);
  assert.match(inner, /: \{ delay: 0\.12, duration: 0\.2, ease: \[0\.23, 1, 0\.32, 1\] \}\}/, 'the badge waits for the space and then arrives in 200ms');
  assert.doesNotMatch(inner, /\by: \d|scale:/);
});

/**
 * SOURCE test for WHEN the card's own pieces arrive.
 *
 * `cardSlideUp` and `pcArrive` used to fire on mount, and the feed mounts
 * cards ahead of the reader through the sliding mount window
 * (utils/feedMountWindow.js): by the time a swipe brings a card to the
 * viewport, the mount window has usually had it for a while and the
 * animation already finished off-screen. The arrival is tied to becoming the
 * active card instead — `.pc[data-active="true"]` — which FeedContainer sets
 * from the same scrollTop/clientHeight math that already drives the snap
 * index. The sheet's own travel (`cardSlideUp`) is dropped outright rather
 * than re-gated: nothing asked for the frame to slide, only the pieces
 * inside it, and the sheet now simply sits at rest.
 */
test('SOURCE: la llegada de los bloques se dispara al volverse activa la tarjeta, no al montar', async () => {
  const css = strip(await read('./PaperCard.css'));
  // The full nine-selector list, not just one piece of it: reverting any of
  // the other eight to a bare `.pc-X` would still pass a test that only
  // checked `.pc-title`, and lose that piece's gating silently.
  assert.match(
    css,
    /\.pc\[data-active="true"\] \.pc-follow-reason,\s*\.pc\[data-active="true"\] \.pc-meta,\s*\.pc\[data-active="true"\] \.pc-chips,\s*\.pc\[data-active="true"\] \.pc-topics,\s*\.pc\[data-active="true"\] \.pc-title,\s*\.pc\[data-active="true"\] \.pc-authors,\s*\.pc\[data-active="true"\] \.pc-abstract,\s*\.pc\[data-active="true"\] \.pc-action-bar,\s*\.pc\[data-active="true"\] \.pc-side-actions \{\s*animation: pcArrive 0\.28s cubic-bezier\(0\.16, 1, 0\.3, 1\) calc\(var\(--arrive, 0\) \* 35ms\) backwards;\s*\}/,
  );
  // Not just "no cardSlideUp by name" (redundant with followingFeed.test.js's
  // own "the keyframes are gone, not just unused" pair) — no `animation:` on
  // `.pc-sheet` at all: the sheet only sits at rest, it does not carry any
  // entrance of its own any more. Bounded by `.pc-sheet`'s own closing brace,
  // not a fixed character count: a `+600` window reaches past this block
  // into `.pc-figure`'s `animation:` (its `figureClipIn` clip-in, a couple
  // hundred characters further on), so any growth of the code between the
  // two blocks would eventually fail this assertion pointing at the wrong
  // rule instead of at an actual `.pc-sheet` regression.
  const pcSheetStart = css.indexOf('.pc-sheet {');
  assert.doesNotMatch(css.slice(pcSheetStart, css.indexOf('}', pcSheetStart)), /animation:/);
  const jsx = strip(await read('./PaperCard.jsx'));
  assert.match(jsx, /data-active=\{isActive \? 'true' : 'false'\}/);
});

/**
 * SOURCE test for reduced motion, which this task's own gating regressed:
 * raising the arrival rule's specificity from one to three (by adding
 * `.pc[data-active="true"]`) let it outrank the reduced-motion block that
 * used to suppress it at equal specificity by coming later in the file. No
 * test caught that when it shipped — this is the guard that would have.
 */
test('SOURCE: prefers-reduced-motion still suppresses the card entrance now that it is gated on data-active', async () => {
  const css = await read('./PaperCard.css');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
  const winner = reduced.find((block) => /\.pc\[data-active="true"\] \.pc-title[\s\S]*?animation: none;/.test(block));
  assert.ok(
    winner,
    'a reduce block suppresses the data-active-qualified arrival selector, not only the pre-Task-11 bare one',
  );
  // Tying (0,3,0) specificity only suppresses the arrival because this block
  // also comes LATER in the file than the rule it mirrors (the comment right
  // above it in PaperCard.css says so) — the win is source order, not
  // specificity. Without pinning that order, a new gated arrival rule added
  // after this block, or this block moved above the arrival rule, would kill
  // reduced motion again with the assertion above still green.
  const arrivalIndex = css.indexOf('.pc[data-active="true"] .pc-follow-reason,');
  assert.ok(arrivalIndex >= 0, 'the arrival rule this block must outrank by order is still findable');
  assert.ok(css.indexOf(winner) > arrivalIndex, 'the reduce block must sit after the arrival rule in source order to win the specificity tie');
});

/**
 * SOURCE test for the regression the previous review round introduced:
 * `.pc-abstract` is the only one of the nine arrival pieces with a
 * `transition` of its own (the 0.42s max-height/mask-size travel that opens
 * and closes it on tap, PaperCard.css `.pc-abstract { transition: … }`). The
 * old giant reduced-motion block used to suppress it through a bare
 * `.pc-abstract` entry; that entry left with the other eight when Finding 1
 * moved them to the dedicated block above, and only `animation: none`
 * came with them — `transition: none` was left behind with nothing to carry
 * it, so `.pc-abstract` kept travelling under reduced motion. A reduced-
 * motion reader who taps "Read full abstract" gets `toggleExpanded`'s own
 * scroll-back (PaperCard.jsx, gated on `prefersReducedMotion`) landing
 * instantly while the panel is still opening over 420ms — the two coming
 * apart, exactly what that function's own comment says this pairing exists
 * to prevent.
 */
test('SOURCE: reduced motion also stops the abstract panel’s own open/close transition, not just the arrival fade', async () => {
  const css = await read('./PaperCard.css');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
  assert.ok(
    reduced.some((block) =>
      /\.pc\[data-active="true"\] \.pc-abstract/.test(block)
      && /animation: none;/.test(block)
      && /transition: none;/.test(block)),
    'the data-active-qualified reduce block sets both animation: none and transition: none, so .pc-abstract’s own 0.42s transition is suppressed too',
  );
});

/**
 * SOURCE test for the entrance replaying on a card the reader never left. A
 * touch drag that hovers on the 50% snap line flips `data-active`
 * true/false/true before committing, and CSS restarts `pcArrive` every time
 * the rule matches again unless something remembers the card already
 * arrived once.
 */
test('SOURCE: the arrival does not replay while the card stays mounted, once it has gone active once', async () => {
  const jsx = strip(await read('./PaperCard.jsx'));
  assert.match(jsx, /const \[wasActive, setWasActive\] = useState\(isActive\);/);
  assert.match(jsx, /const \[hasArrived, setHasArrived\] = useState\(false\);/);
  assert.match(
    jsx,
    /if \(isActive !== wasActive\) \{\s*setWasActive\(isActive\);\s*if \(wasActive && !hasArrived\) setHasArrived\(true\);\s*\}/,
  );
  assert.match(jsx, /data-arrived=\{hasArrived \? 'true' : undefined\}/);

  const css = strip(await read('./PaperCard.css'));
  // Specificity four (`.pc` + `[data-active="true"]` + `[data-arrived]` +
  // the piece) beats the plain arrival rule's three unconditionally, the
  // same margin the back-nav suppression keeps.
  assert.match(
    css,
    /\.pc\[data-active="true"\]\[data-arrived\] \.pc-follow-reason,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-meta,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-chips,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-topics,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-title,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-authors,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-abstract,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-action-bar,\s*\.pc\[data-active="true"\]\[data-arrived\] \.pc-side-actions \{\s*animation: none;\s*\}/,
  );
});
