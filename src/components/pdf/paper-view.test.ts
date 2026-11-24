import assert from 'node:assert/strict';
import test from 'node:test';
import { matchPaperView } from './paper-view.ts';

test('a viewer\'s address names its paper and tab, and no other path is one', () => {
  assert.deepEqual(matchPaperView('/paper/doi%3A10.48550%2Farxiv.2005.14165/read'), { paperKey: 'doi:10.48550/arxiv.2005.14165', view: 'paper' });
  assert.deepEqual(matchPaperView('/paper/arxiv%3A2005.14165/listen'), { paperKey: 'arxiv:2005.14165', view: 'listen' });
  assert.deepEqual(matchPaperView('/paper/ZG9pOjEwLjQ4NTUwL2FyeGl2LjIwMDUuMTQxNjU/summary'), { paperKey: 'ZG9pOjEwLjQ4NTUwL2FyeGl2LjIwMDUuMTQxNjU', view: 'summary' }, 'the app\'s own addresses');
  assert.deepEqual(matchPaperView('/paper/arxiv%3A2005.14165/summary'), { paperKey: 'arxiv:2005.14165', view: 'summary' });
  assert.equal(matchPaperView('/paper/arxiv%3A2005.14165'), null);
  assert.equal(matchPaperView('/paper/arxiv%3A2005.14165/comments'), null);
  assert.equal(matchPaperView('/feed'), null);
});
