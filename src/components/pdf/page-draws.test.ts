import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageDraws } from './page-draws.ts';

test('a page failing while another is still drawing does not hand the PDF off', () => {
  const draws = createPageDraws();
  draws.start();
  draws.start();
  assert.equal(draws.settle('failed'), false);
  assert.equal(draws.settle('drawn'), false);
});

test('the PDF is handed off once every started draw has failed', () => {
  const draws = createPageDraws();
  draws.start();
  draws.start();
  assert.equal(draws.settle('failed'), false);
  assert.equal(draws.settle('failed'), true);
});

test('a failure after a page was drawn does not hand the PDF off', () => {
  const draws = createPageDraws();
  draws.start();
  assert.equal(draws.settle('drawn'), false);
  draws.start();
  assert.equal(draws.settle('failed'), false);
});

test('a cancelled draw is not a failure', () => {
  const draws = createPageDraws();
  draws.start();
  assert.equal(draws.settle('cancelled'), false);
});
