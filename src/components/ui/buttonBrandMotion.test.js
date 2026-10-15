import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE test for the AI reading button's hover.
 *
 * Until 2026-10-15 the brand button lifted 2px with a shadow under the pointer
 * (restored 2026-09-17 after e56a7ea had dropped `.pc-ai-btn`'s lift). The
 * riso system took the movement away: the page does not float, every shadow
 * token is `none`, and a button sliding up was the one thing on the card that
 * did. What moves now is only the sparkle icon, turning and growing a touch;
 * the button takes the full spot plate in an ink frame, the engraved
 * button's look, and its press is the base's 0.97.
 */
test('the brand button stays on the page under the pointer; only its icon moves', async () => {
  const source = await read('./button-variants.js');
  const brand = source.match(/^\s*brand: '([^']*)',$/m)?.[1];
  assert.ok(brand, 'the brand variant is one string');
  const classes = brand.split(/\s+/);
  // No lift, no shadow, no press of its own.
  for (const pattern of [/translate-y/, /shadow/, /active:scale/]) {
    assert.ok(!classes.some((cls) => pattern.test(cls)), `nothing matching ${pattern} on the brand variant`);
  }
  // The icon keeps its turn, and gives it up under reduced motion.
  for (const cls of ['[&:hover_svg]:scale-110', '[&:hover_svg]:rotate-[8deg]', 'motion-reduce:[&:hover_svg]:scale-100', 'motion-reduce:[&:hover_svg]:rotate-0']) {
    assert.ok(classes.includes(cls), `${cls} is on the brand variant`);
  }
  // Riso colours only: spot yellow at rest, the yellow plate framed in ink on
  // hover. No orange, no status tint.
  assert.ok(classes.includes('border-[var(--brand-yellow)]'));
  assert.ok(classes.includes('hover:bg-brand'));
  assert.ok(classes.includes('hover:border-[var(--border-ink)]'));
  assert.ok(!/brand-orange|tint-amber/.test(brand));
});
