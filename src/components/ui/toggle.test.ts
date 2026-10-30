import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleVariants } from './toggle-variants.ts';

/**
 * A pending toggle keeps focus, so its focus ring must keep full contrast:
 * dimming the whole button drew the ring at half opacity (2.93:1 in light).
 * The dim falls on its contents instead.
 */
test('a pending toggle dims its contents, not the button that draws the focus ring', () => {
  const classes = toggleVariants().split(/\s+/);
  assert.ok(!classes.some(name => name.startsWith('aria-disabled:opacity-')), 'the button itself keeps full opacity');
  assert.ok(classes.some(name => name.startsWith('aria-disabled:*:opacity-')), 'its contents dim');
});
