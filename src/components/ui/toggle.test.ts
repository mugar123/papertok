import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { pendingToggleProps } from './toggle-press.ts';
import { toggleVariants } from './toggle-variants.ts';

// toggle.tsx is JSX, which Node cannot load; this renders the Base UI Toggle
// with the props toggle.tsx spreads onto it for its `pending` state.
const paint = (pending: boolean) => renderToStaticMarkup(
  createElement(TogglePrimitive, { pressed: false, 'aria-label': 'Follow', ...pendingToggleProps(pending, () => {}) }),
);

/**
 * A Follow whose press is being saved keeps keyboard focus: a native
 * `disabled` would blur it and drop a keyboard reader to the page (WCAG
 * 2.4.3). Base UI must keep the `aria-disabled` it is given and add no
 * native `disabled` of its own.
 */
test('a pending toggle is marked aria-disabled and stays focusable', () => {
  const markup = paint(true);
  assert.match(markup, /aria-disabled="true"/);
  assert.doesNotMatch(markup, /\sdisabled(=|\s|>)/, 'no native disabled attribute');
  assert.doesNotMatch(markup, /tabindex="-1"/, 'still in the tab order');
});

test('a toggle that is not pending is not marked disabled', () => {
  assert.doesNotMatch(paint(false), /disabled/);
});

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
