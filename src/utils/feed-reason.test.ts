import assert from 'node:assert/strict';
import test from 'node:test';

import type { Paper } from '../models/paper.ts';
import { scorePaperForRecommendation } from './recommendation-engine.ts';
import { feedReason } from './feed-reason.ts';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

function scored(paper: Partial<Paper>, context: Parameters<typeof scorePaperForRecommendation>[1] = {}) {
  return { ...paper, _debugScore: scorePaperForRecommendation(paper, { now: NOW, ...context }) };
}

const paper: Partial<Paper> = {
  id: 'p1',
  primaryCategory: 'cs.LG',
  categories: ['cs.LG'],
  published: '2026-11-20',
  abstract: 'A long enough abstract about learning representations from data, with methods and results described in it.',
};

test('a follow is named first, before every other reason', () => {
  const card = scored({ ...paper, _notable: true, _semanticScore: 0.9 }, { userPreferences: ['cs.LG'], exampleKinds: ['liked'] });
  assert.deepEqual(feedReason(card, { type: 'author', name: 'Yann LeCun' }, 'Machine Learning'), { kind: 'follow', text: 'Because you follow Yann LeCun' });
  assert.equal(feedReason(card, { type: 'topic', name: '' }, 'Machine Learning')?.text, 'Because you follow this topic');
});

test('a notable card is highly cited in its area only with the citations to show for it', () => {
  const card = scored({ ...paper, _notable: true, citationCount: 4200 }, { userPreferences: ['cs.LG'] });
  assert.deepEqual(feedReason(card, null, 'Machine Learning'), { kind: 'classic', text: 'Highly cited in Machine Learning' });
  assert.equal(feedReason({ _notable: true, citationCount: 2 }, null, 'Machine Learning'), null);
  assert.equal(feedReason({ _notable: true }, null, 'Machine Learning'), null);
  assert.equal(feedReason({ _notable: true, citationCount: 4200 }, null, null), null);
});

test('similarity names the examples the reader has', () => {
  const close = { ...paper, _semanticScore: 0.8 };
  assert.equal(feedReason(scored(close, { userPreferences: ['cs.LG'], exampleKinds: ['liked'] }), null, 'Machine Learning')?.text, 'Similar to papers you liked');
  assert.equal(feedReason(scored(close, { exampleKinds: ['saved'] }), null, 'Machine Learning')?.text, 'Similar to papers you saved');
  assert.equal(feedReason(scored(close, { exampleKinds: ['liked', 'saved'] }), null, null)?.text, 'Similar to papers you liked or saved');
  assert.equal(feedReason(scored(close, { exampleKinds: ['liked', 'saved', 'read'] }), null, null)?.text, 'Similar to papers you engaged with');
  assert.equal(feedReason(scored(close, { exampleKinds: ['read'] }), null, null)?.text, 'Similar to papers you engaged with');
});

test('no similarity label without examples, or with a weak or outweighed match', () => {
  const inArea = { userPreferences: ['cs.LG'] };
  assert.equal(feedReason(scored({ ...paper, _semanticScore: 0.8 }, inArea), null, 'Machine Learning')?.kind, 'area');
  assert.equal(feedReason(scored({ ...paper, _semanticScore: 0.1 }, { ...inArea, exampleKinds: ['liked'] }), null, 'Machine Learning')?.kind, 'area');
  const outweighed = scored({ ...paper, authors: ['Ada Lovelace'], _semanticScore: 0.3 }, { ...inArea, followedAuthors: ['Ada Lovelace'], exampleKinds: ['liked'] });
  assert.equal(feedReason(outweighed, null, 'Machine Learning')?.kind, 'area');
  // Added after the reader opened a paper, and ranked by that paper.
  const opened = scored({ ...paper, _semanticScore: 0.9, _isGraphCandidate: true }, { ...inArea, exampleKinds: ['liked'] });
  assert.equal(feedReason(opened, null, 'Machine Learning')?.kind, 'area');
});

test('a card of an area the reader picked is in their area; other cards and unscored ones have no reason', () => {
  assert.deepEqual(feedReason(scored(paper, { userPreferences: ['cs.LG'] }), null, 'Machine Learning'), { kind: 'area', text: 'In your area' });
  assert.equal(feedReason(scored(paper, { userPreferences: ['math.NT'] }), null, 'Machine Learning'), null);
  assert.equal(feedReason(paper, null, 'Machine Learning'), null);
});
