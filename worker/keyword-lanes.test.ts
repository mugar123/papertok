import assert from 'node:assert/strict';
import test from 'node:test';

import { keywordFilter, keywordSearchText } from './keyword-lanes.ts';

// Inside an OpenAlex filter `|` is an "or" (14 million results when tried),
// `:` returns nothing and a comma starts another filter.
test('a keyword keeps only what a filter value can carry', () => {
  assert.equal(keywordSearchText('LMSR  Prediction Markets'), 'lmsr prediction markets');
  assert.equal(keywordSearchText('p|q logic'), 'p q logic');
  assert.equal(keywordSearchText('tcp:ip'), 'tcp ip');
  assert.equal(keywordSearchText('markets, prediction'), 'markets prediction');
  assert.equal(keywordSearchText('"sparse" autoencoders'), 'sparse autoencoders');
  assert.equal(keywordSearchText('crispr base editing off-target'), 'crispr base editing off-target');
  assert.equal(keywordSearchText('-leading and trailing-'), 'leading and trailing');
  assert.equal(keywordSearchText('c++ templates'), 'c templates');
  assert.equal(keywordSearchText('+++'), '');
});

// Split at its apostrophe, "alzheimer's" would also ask for a word "s".
test('a possessive stays one word', () => {
  assert.equal(keywordSearchText("Alzheimer's disease"), 'alzheimers disease');
  assert.equal(keywordSearchText('Moore’s law'), 'moores law');
  assert.equal(keywordSearchText("'quoted' words"), 'quoted words');
});

test('a keyword in a script that writes its vowels as marks keeps them', () => {
  assert.equal(keywordSearchText('हिंदी भाषा'), 'हिंदी भाषा');
});

test('a keyword is asked in titles and abstracts, as a phrase or as loose words', () => {
  const tail = 'is_retracted:false,type:article|review|conference-paper|preprint';
  assert.equal(keywordFilter('quadratic funding', 'phrase'), `title_and_abstract.search:"quadratic funding",${tail}`);
  assert.equal(keywordFilter('quadratic funding', 'words'), `title_and_abstract.search:quadratic funding,${tail}`);
});
