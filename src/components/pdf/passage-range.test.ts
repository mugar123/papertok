import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteOffsets } from './passage-range.ts';

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
