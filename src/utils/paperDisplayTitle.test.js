import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholderPaperTitle, resolvedPaperTitle } from './paperDisplayTitle.js';

test('empty and identity-shaped strings are not titles', () => {
  assert.equal(isPlaceholderPaperTitle('', 'x'), true);
  assert.equal(isPlaceholderPaperTitle(null, 'x'), true);
  assert.equal(isPlaceholderPaperTitle('openalex:W2269592689', 'openalex:W2269592689'), true);
  assert.equal(isPlaceholderPaperTitle('openalex:W2011573164', 'other'), true);
  assert.equal(isPlaceholderPaperTitle('1807.10247', '1807.10247'), true);
  assert.equal(isPlaceholderPaperTitle('hep-th/0603001', 'hep-th/0603001'), true);
  assert.equal(isPlaceholderPaperTitle('ads:2021JHEP...03..014J', 'ads:2021JHEP...03..014J'), true);
  assert.equal(isPlaceholderPaperTitle('Paper sin titulo', 'x'), true);
  assert.equal(isPlaceholderPaperTitle('Untitled paper', 'x'), true);
});

test('resolvedPaperTitle drops placeholders and keeps real names', () => {
  assert.equal(resolvedPaperTitle('openalex:W1', 'openalex:W1'), '');
  assert.equal(resolvedPaperTitle('  Real title  ', 'openalex:W1'), 'Real title');
});
