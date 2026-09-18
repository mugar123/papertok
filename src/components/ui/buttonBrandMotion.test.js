import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE test for the AI reading button's movement.
 *
 * Until e56a7ea (2026-08-29) the card's "Read in plain words" button was
 * `.pc-ai-btn`, with a 2px lift under the pointer and a 4% give under the
 * finger, both on 180ms of the expo-out curve. The design system moved it
 * onto the shared Button with the `brand` variant, which only transitioned
 * colours: the built stylesheet carried no `translate` or `scale` utility at
 * all, and the reader noticed the button had stopped moving (2026-09-17).
 *
 * The movement lives on the variant, not on a bespoke class (design.md,
 * rule 5), on Tailwind 4's individual `translate` and `scale` properties so
 * the press cannot overwrite the lift, and it stands down under reduced
 * motion (rule 7) while the colours stay.
 */
test('the brand button lifts under the pointer, gives under the finger, and stands still under reduced motion', async () => {
  const source = await read('./button-variants.js');
  const brand = source.match(/^\s*brand: '([^']*)',$/m)?.[1];
  assert.ok(brand, 'the brand variant is one string');
  const classes = brand.split(/\s+/);
  for (const cls of [
    'hover:-translate-y-0.5',
    'active:scale-[0.96]',
    'active:translate-y-0',
    'hover:shadow-[var(--shadow-md)]',
    'active:shadow-none',
    'motion-reduce:hover:translate-y-0',
    'motion-reduce:active:scale-100',
    'motion-reduce:hover:shadow-none',
    '[&:hover_svg]:scale-110',
    'motion-reduce:[&:hover_svg]:scale-100',
  ]) {
    assert.ok(classes.includes(cls), `${cls} is on the brand variant`);
  }
  // Each property on its own clock (polished 2026-09-18): the colours cross
  // on a straight line, the lift arrives on the expo curve and settles back
  // on the quad, and the press is the quickest thing here. Two shorthands:
  // the base one is the way back, the hover one the way in.
  const base = classes.find((cls) => cls.startsWith('[transition:'));
  const enter = classes.find((cls) => cls.startsWith('hover:[transition:'));
  assert.ok(base && enter, 'the variant names its transition properties, in and out');
  for (const prop of ['color_160ms_linear', 'background-color_160ms_linear', 'border-color_160ms_linear', 'translate_220ms_var(--ease-out-quad)', 'scale_120ms_var(--ease-out-expo)', 'box-shadow_220ms']) {
    assert.ok(base.includes(prop), `${prop} on the way back`);
  }
  for (const prop of ['translate_180ms_var(--ease-out-expo)', 'color_160ms_linear', 'box-shadow_180ms']) {
    assert.ok(enter.includes(prop), `${prop} on the way in`);
  }
  // Nothing in it animates `transform` itself: the card's arrival animates
  // that on the row above, and a transform here would be the second owner
  // paperCardArrival.test.js already had to fight on the side rail.
  assert.ok(!classes.some((cls) => /(^|:)(transform|-?translate-x)/.test(cls) && !cls.includes('[transition:')));
});
