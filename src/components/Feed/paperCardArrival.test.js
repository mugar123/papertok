import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

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
 * The toggle under the old in-card abstract was shown only once a measurement
 * said the panel hid words, a couple of frames after mount, and on a
 * bottom-anchored phone column it pushed the title and the kicker 25 px up
 * mid-arrival (measured 2026-09-17). The abstract has since left the card; its
 * door is rendered from the first frame on the one fact known at render —
 * whether there is an abstract — so there is no verdict left to wait for.
 */
test('the abstract door is decided at render, so the arrival plays over a still layout', async () => {
  const jsx = await read('./PaperCard.jsx');
  assert.match(jsx, /\{abstractText && \(\s*<button\s+type="button"\s+className="pc-abstract-link"/);
  assert.match(jsx, /const abstractText = hasUsableAIAbstract\(paper\.abstract\) \? paper\.abstract : null;/);
  const css = await read('./PaperCard.css');
  assert.match(css, /\.pc-abstract-link \{ --arrive: 3; \}/, 'it arrives in step with the rest');
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
