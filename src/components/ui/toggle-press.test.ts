import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingToggleProps } from './toggle-press.ts';

function press() {
  const calls: string[] = [];
  return {
    calls,
    event: {
      preventDefault: () => calls.push('preventDefault'),
      stopPropagation: () => calls.push('stopPropagation'),
      preventBaseUIHandler: () => calls.push('preventBaseUIHandler'),
    },
  };
}

/**
 * A Follow in a search result or a palette item sits inside a row that opens
 * when clicked. A second Enter (or key repeat) while the first follow is saved
 * must not fall through to that row and navigate away.
 */
test('a press on a pending toggle does not flip it, run its handler or reach the row around it', () => {
  let handled = 0;
  const { calls, event } = press();
  pendingToggleProps(true, () => { handled += 1; }).onClick(event);
  assert.equal(handled, 0, 'the caller does not hear the press');
  assert.ok(calls.includes('stopPropagation'), 'the click stops at the toggle');
  assert.ok(calls.includes('preventBaseUIHandler'), 'Base UI does not flip the toggle');
});

test('a press on a toggle that is not pending reaches its handler', () => {
  let handled = 0;
  const { calls, event } = press();
  pendingToggleProps(false, () => { handled += 1; }).onClick(event);
  assert.equal(handled, 1);
  assert.deepEqual(calls, [], 'the press is left to the handler');
});
