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
