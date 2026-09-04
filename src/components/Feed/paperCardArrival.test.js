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
