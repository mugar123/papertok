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
