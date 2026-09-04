import test from 'node:test';
import assert from 'node:assert/strict';
import { directionForNavigationType } from './routeDirection.js';

test('a new entry pushes forward', () => {
  assert.equal(directionForNavigationType('PUSH'), 1);
});

test('a step back through history pops', () => {
  // What the Explorer's back arrow produces: `handleBack` calls `navigate(-1)`
  // whenever `window.history.state.idx` says there is somewhere to go back to.
  assert.equal(directionForNavigationType('POP'), -1);
});

test('a replace is not a step and gets no travel', () => {
  // Redirects — the guest bounced off a gated route, sign-in landing back where
  // it started — swap the entry in place. Sliding one would animate a journey
  // that did not happen.
  assert.equal(directionForNavigationType('REPLACE'), 0);
});

test('anything the router does not name is treated as no direction', () => {
  assert.equal(directionForNavigationType(undefined), 0);
  assert.equal(directionForNavigationType(null), 0);
  assert.equal(directionForNavigationType('SOMETHING_NEW'), 0);
});

test('the first entry in history is an arrival, not a return', () => {
  // The router reports POP for the very first render too — there was no push
  // — and a feed that treated that as a return sat its cards at rest under the
  // atom veil, so the first paper appeared already composed. `history.state.idx`
  // is 0 on that entry and only ever greater after a push.
  assert.equal(directionForNavigationType('POP', { historyIndex: 0 }), 0);
  assert.equal(directionForNavigationType('POP', { historyIndex: 2 }), -1);
  // Without an index to read, a pop is still a pop.
  assert.equal(directionForNavigationType('POP', { historyIndex: null }), -1);
  assert.equal(directionForNavigationType('POP', {}), -1);
});

import { directionForHistoryIndex } from './routeDirection.js';

/**
 * React Router 7.18's HashRouter reports POP for every navigation here —
 * measured on the tab bar: a NavLink push and a `navigate('/')` both arrived
 * as POP with the history index at 1 and 2. Read through the type, every
 * page entered as a return and the cards never composed. The index is the
 * signal the router cannot get wrong: it grows on a push, shrinks on a step
 * back, and holds on a replace.
 */
test('the history index decides: up is forward, down is back, level is a replace', () => {
  const memory = {};
  assert.equal(directionForHistoryIndex(0, memory), 0, 'the first entry is an arrival');
  assert.equal(directionForHistoryIndex(1, memory), 1, 'a push goes deeper');
  assert.equal(directionForHistoryIndex(2, memory), 1);
  assert.equal(directionForHistoryIndex(1, memory), -1, 'a step back returns');
  assert.equal(directionForHistoryIndex(1, memory), -1, 'and stays put while the same entry re-renders');
  assert.equal(directionForHistoryIndex(2, memory), 1, 'forward through history arrives again');
});

test('a reload deep in history is still an arrival, and a replace is not a step', () => {
  const memory = {};
  assert.equal(directionForHistoryIndex(3, memory), 0);
  assert.equal(directionForHistoryIndex(3, memory), 0, 'a replace keeps the index and gets no travel');
});

test('without an index the navigation type still answers', () => {
  const memory = {};
  assert.equal(directionForHistoryIndex(null, memory, 'PUSH'), 1);
  assert.equal(directionForHistoryIndex(undefined, memory, 'POP'), -1);
  assert.equal(directionForHistoryIndex(undefined, memory), 0);
});
