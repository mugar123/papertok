import test from 'node:test';
import assert from 'node:assert/strict';
import { buttonVariants } from './button-variants.ts';

/**
 * The AI reading button's hover.
 *
 * Until 2026-10-15 the brand button lifted 2px with a shadow under the pointer
 * (restored 2026-09-17 after e56a7ea had dropped `.pc-ai-btn`'s lift). The
 * PaperTok design system took the movement away: the page does not float, every shadow
 * token is `none`, and a button sliding up was the one thing on the card that
 * did. What moves now is only the sparkle icon, turning and growing a touch,
 * and its press is the base's 0.97.
 */
test('the brand button stays on the page under the pointer; only its icon moves', () => {
  const classes = buttonVariants({ variant: 'brand' }).split(/\s+/);
  // No lift, no shadow, no press of its own.
  for (const pattern of [/translate-y/, /shadow/]) {
    assert.ok(!classes.some((cls) => pattern.test(cls)), `nothing matching ${pattern} on the brand button`);
  }
  assert.deepEqual(classes.filter((cls) => /active:scale/.test(cls)), ['active:scale-[0.97]', 'motion-reduce:active:scale-100'],
    'the press is the base squeeze, given up under reduced motion');
  // The icon keeps its turn, and gives it up under reduced motion.
  for (const cls of ['[&:hover_svg]:scale-110', '[&:hover_svg]:rotate-[8deg]', 'motion-reduce:[&:hover_svg]:scale-100', 'motion-reduce:[&:hover_svg]:rotate-0']) {
    assert.ok(classes.includes(cls), `${cls} is on the brand button`);
  }
});
