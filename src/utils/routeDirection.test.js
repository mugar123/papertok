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
