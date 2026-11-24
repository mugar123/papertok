import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { markSeparatorLineEnds } from './separator-line-ends.ts';

/** A masthead row laid out by hand: each item's line top, as the browser would place it. */
function row(items: Array<[className: string, top: number]>) {
  const element = document.createElement('div');
  for (const [className, top] of items) {
    const item = document.createElement('span');
    item.className = className;
    Object.defineProperties(item, { offsetTop: { value: top, configurable: true }, offsetHeight: { value: 16 } });
    element.append(item);
  }
  return element;
}

test('a separator the row wraps after is marked, and one between items on a line is not', () => {
  const masthead = row([['field', 0], ['pc-meta-dot', 0], ['date', 0], ['pc-meta-dot', 0], ['citations', 24]]);
  markSeparatorLineEnds(masthead);
  const [between, wrapped] = masthead.querySelectorAll('.pc-meta-dot');
  assert.equal(between.hasAttribute('data-line-end'), false);
  assert.equal(wrapped.hasAttribute('data-line-end'), true);

  // Wider, the row fits on one line again and the mark comes off.
  Object.defineProperty(masthead.lastElementChild, 'offsetTop', { value: 0 });
  markSeparatorLineEnds(masthead);
  assert.equal(wrapped.hasAttribute('data-line-end'), false);
});
