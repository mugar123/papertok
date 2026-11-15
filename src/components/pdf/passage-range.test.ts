import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceBefore, quoteOffsets } from './passage-range.ts';

test('a quote is found across the line breaks and runs of spaces of the page text', () => {
  const text = 'The model\n   scored better than earlier  systems.';
  const at = quoteOffsets(text, 'model scored better');
  assert.deepEqual(at, [4, 26]);
  assert.equal(text.slice(...at), 'model\n   scored better');
});

test('a quote that is no longer in the text is not found', () => {
  assert.equal(quoteOffsets('The model scored better.', 'scored worse'), null);
  assert.equal(quoteOffsets('The model scored better.', '   '), null);
});

test('a repeated quote is found at the occurrence that was marked', () => {
  const text = 'the model fails. Later,\n the  model succeeds.';
  const second = quoteOffsets(text, 'the model', 1);
  assert.ok(second);
  assert.equal(text.slice(...second), 'the  model');
  assert.equal(quoteOffsets(text, 'the model', 2), null);
});

test('the occurrence counts the same words that start before the selection', () => {
  const text = 'the model fails, and the model succeeds';
  assert.equal(occurrenceBefore(text, 'the model', 0), 0);
  assert.equal(occurrenceBefore(text, 'the model', text.lastIndexOf('the model')), 1);
});
