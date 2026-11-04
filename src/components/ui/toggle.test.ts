import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toggle } from './toggle.ts';

const paint = (pending: boolean) => renderToStaticMarkup(
  createElement(Toggle, { pending, pressed: false, 'aria-label': 'Follow', onClick: () => {} }),
);

/** Presses the button Toggle renders, as a click (or Enter, which a native button turns into one) would. */
function press(pending: boolean) {
  let handled = 0;
  const calls: string[] = [];
  const { onClick } = Toggle({ pending, pressed: false, 'aria-label': 'Follow', onClick: () => { handled += 1; } }).props;
  assert.ok(typeof onClick === 'function', 'the button takes clicks');
  // Only what a press handler may call on the event.
  onClick({
    preventDefault: () => { calls.push('preventDefault'); },
    stopPropagation: () => { calls.push('stopPropagation'); },
    preventBaseUIHandler: () => { calls.push('preventBaseUIHandler'); },
  } as Parameters<typeof onClick>[0]);
  return { handled, calls };
}

/**
 * A Follow whose press is being saved keeps keyboard focus: a native
 * `disabled` would blur it and drop a keyboard reader to the page (WCAG
 * 2.4.3).
 */
test('a pending toggle is a button marked aria-disabled that stays focusable', () => {
  const markup = paint(true);
  assert.match(markup, /^<button/);
  assert.match(markup, /aria-disabled="true"/);
  assert.doesNotMatch(markup, /\sdisabled(=|\s|>)/, 'no native disabled attribute');
  assert.doesNotMatch(markup, /tabindex="-1"/, 'still in the tab order');
});

test('a toggle that is not pending is not marked disabled', () => {
  assert.doesNotMatch(paint(false), /\s(aria-)?disabled(=|\s|>)/);
});

/**
 * A Follow in a search result or a palette item sits inside a row that opens
 * when clicked. A second press while the first is saved must not run the
 * handler again, flip the toggle, or fall through to the row and navigate.
 */
test('a press on a pending toggle reaches neither its handler nor the row around it', () => {
  const { handled, calls } = press(true);
  assert.equal(handled, 0, 'the caller does not hear the press');
  assert.ok(calls.includes('stopPropagation'), 'the click stops at the toggle');
  assert.ok(calls.includes('preventBaseUIHandler'), 'Base UI does not flip the toggle');
});

test('a press on a toggle that is not pending reaches its handler', () => {
  assert.equal(press(false).handled, 1);
});
