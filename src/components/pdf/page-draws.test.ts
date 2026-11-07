import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageDraws } from './page-draws.ts';

test('a page failing while another is still drawing does not hand the PDF off', () => {
  const draws = createPageDraws();
  draws.start();
  draws.start();
  assert.equal(draws.settle(1, 10, 'failed'), null);
  assert.equal(draws.settle(2, 10, 'drawn'), null);
});

test('when the only page drawn fails, the next untried page is drawn before handing off', () => {
  const draws = createPageDraws();
  draws.start();
  assert.equal(draws.settle(1, 10, 'failed'), 2);
  draws.start();
  assert.equal(draws.settle(2, 10, 'failed'), 3);
  draws.start();
  assert.equal(draws.settle(3, 10, 'failed'), 'hand-off');
});

test('a page drawn after the first failures keeps the PDF', () => {
  const draws = createPageDraws();
  draws.start();
  assert.equal(draws.settle(1, 10, 'failed'), 2);
  draws.start();
  assert.equal(draws.settle(2, 10, 'drawn'), null);
});

test('a PDF with fewer pages than the limit is handed off once all of them fail', () => {
  const draws = createPageDraws();
  draws.start();
  draws.start();
  assert.equal(draws.settle(1, 2, 'failed'), null);
  assert.equal(draws.settle(2, 2, 'failed'), 'hand-off');
});

test('a failure after a page was drawn does not hand the PDF off', () => {
  const draws = createPageDraws();
  draws.start();
  assert.equal(draws.settle(1, 10, 'drawn'), null);
  draws.start();
  assert.equal(draws.settle(2, 10, 'failed'), null);
});

test('a cancelled draw is not a failure', () => {
  const draws = createPageDraws();
  draws.start();
  assert.equal(draws.settle(1, 10, 'cancelled'), null);
});

test('cancelling the last draw in flight after a failure neither hands off nor probes', () => {
  const draws = createPageDraws();
  draws.start();
  draws.start();
  assert.equal(draws.settle(1, 10, 'failed'), null);
  assert.equal(draws.settle(2, 10, 'cancelled'), null);
});

test('cancelling the last draw in flight after enough failures does not hand off', () => {
  const draws = createPageDraws();
  draws.start();
  draws.start();
  draws.start();
  draws.start();
  assert.equal(draws.settle(1, 10, 'failed'), null);
  assert.equal(draws.settle(2, 10, 'failed'), null);
  assert.equal(draws.settle(3, 10, 'failed'), null);
  assert.equal(draws.settle(4, 10, 'cancelled'), null);
});
