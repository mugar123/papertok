import test from 'node:test';
import assert from 'node:assert/strict';
import { buttonVariants } from './button-variants.ts';

/**
 * Base UI gives a button disabled with `focusableWhenDisabled` (the sign-in
 * buttons while Google's window is prepared) `aria-disabled` and
 * `data-disabled`, never the native attribute, so `:disabled` misses it and
 * it kept the enabled look and hover. It has to look as disabled as a
 * natively disabled button.
 */
test('a button disabled but kept focusable looks like a natively disabled one', () => {
  const classes = buttonVariants({ variant: 'outline' }).split(/\s+/);
  const native = classes.filter(name => name.startsWith('disabled:'));
  assert.ok(native.length > 0, 'a natively disabled button has a look of its own');
  for (const name of native) {
    assert.ok(classes.includes(name.replace(/^disabled:/, 'data-disabled:')), `${name} applies to data-disabled too`);
  }
});
