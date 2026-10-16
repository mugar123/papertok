import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE test for the frame at the end of an animation.
 *
 * A CSS animation that touches `transform` REPLACES the rule's own
 * `transform` for as long as it runs, and hands it back in a single frame
 * when it ends. So an element that is placed by a base `transform` -- the
 * `translate(-50%, -50%)` half of a centring, say -- and also runs a keyframe
 * that writes `transform` is displaced for the length of the animation and
 * snaps into place when it finishes. Nothing warns: both declarations are
 * valid, and the animation looks right in isolation.
 *
 * Measured 2026-09-07 on `.graph-chip`, the "This paper" label beside the
 * black centre dot of the citation map. It centres itself on the rule with
 * `transform: translateY(-50%)` and borrowed `relatedItemIn`, a keyframe
 * shared with three other rules that only slides 6px and knows nothing about
 * any centring. The label therefore sat 5.5px BELOW the dot for the whole
 * 280ms arrival and jumped up 5.5px in one frame the moment it ended.
 *
 * The rule is not "never both". `heartPop`, `ringExpand` and `scrollNudge`
 * are written for the one element each places, and every keyframe of theirs
 * repeats that element's centring -- which is exactly what makes them safe.
 * What this test forbids is the other shape: a base `transform` and a
 * keyframe that drops it.
 *
 * The fix, when it trips: move the placement to the NATIVE `translate` /
 * `scale` properties, which compose with `transform` instead of being
 * replaced by it (the same reason `dialogIn` in styles/variables.css animates
 * `scale` and never `transform`).
 */

const CSS = new URL('./PaperCard.css', import.meta.url);

/** The first function of a transform value: the placement, not the flourish. */
const firstFunction = (value) => value.trim().match(/^[\w-]+\([^)]*\)/)?.[0] ?? '';

test('no rule keeps a base transform that its own animation would drop', async () => {
  const css = await readFile(CSS, 'utf8');

  // Keyframes first: they are the only blocks here that nest, so they come
  // out before the flat rules are matched.
  const keyframes = new Map();
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    keyframes.set(match[1], match[2]);
  }
  assert.ok(keyframes.has('relatedItemIn'), 'the keyframes did not parse');

  const flat = css.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');

  const checked = [];
  for (const rule of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2];
    const base = body.match(/^[ \t]*transform:\s*([^;]+);/m)?.[1];
    const name = body.match(/^[ \t]*animation:\s*([\w-]+)/m)?.[1];
    if (!base || !name) continue;

    const frames = keyframes.get(name);
    // `animation: none` and animations that never touch transform are not
    // this shape at all.
    if (!frames || !/transform/.test(frames)) continue;

    // The selector's own line: a rule inside `@media` carries the prelude.
    const selector = rule[1].trim().split('\n').pop().trim();
    const placement = firstFunction(base);
    checked.push(selector);

    for (const frame of frames.matchAll(/\{([^{}]*)\}/g)) {
      if (!/transform/.test(frame[1])) continue;
      assert.ok(
        frame[1].includes(placement),
        `${selector} is placed by \`${placement}\` and runs \`${name}\`, whose keyframe `
        + `\`${frame[1].trim()}\` drops it. The element is displaced while the animation runs `
        + 'and jumps into place in one frame when it ends. Place it with the native `translate` '
        + 'property instead, which composes with `transform` rather than being replaced by it.',
      );
    }
  }

  // A parser that silently matched nothing would pass this test in silence.
  assert.ok(
    checked.length >= 3,
    `only ${checked.length} rule(s) reached the check; the stylesheet or this parser has moved`,
  );
});
