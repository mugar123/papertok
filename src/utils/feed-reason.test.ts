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

test('only a feed that placed the card gives a causal follow reason', () => {
  const card = scored({ ...paper, _notable: true, citationCount: 500, _fetchedFor: ['cs.LG'] });
  for (const surface of ['feed', 'following', 'custom_feed']) {
    assert.deepEqual(feedReason(card, { type: 'author', name: 'Yann LeCun' }, surface),
      { kind: 'follow', followType: 'author', text: 'Because you follow Yann LeCun' });
    assert.equal(feedReason(card, { type: 'topic', name: '' }, surface)?.text, 'Because you follow this topic');
  }
  for (const surface of ['search', 'lists', 'explorer', 'other', 'connections', 'recent']) {
    assert.deepEqual(feedReason(card, { type: 'journal', name: 'Nature' }, surface),
      { kind: 'follow', followType: 'journal', text: 'You follow Nature' });
    assert.equal(feedReason(card, { type: 'author', name: '' }, surface)?.text, 'You follow this author');
    assert.equal(feedReason(card, null, surface), null);
  }
  assert.equal(feedReason(card, null, 'custom_feed'), null);
});

test('a highly cited card names its notable leaf even if its own classification differs', () => {
  const card = scored({ ...paper, primaryCategory: 'cs.CV', _notable: true, citationCount: 100, _fetchedFor: ['cs.LG', 'cs.AI'] },
    { userPreferences: ['cs.CV'] });
  assert.deepEqual(feedReason(card, null, 'feed'), { kind: 'classic', text: 'Highly cited in Machine Learning' });
  assert.equal(feedReason({ ...card, citationCount: 99 }, null, 'feed'), null);
  assert.equal(feedReason({ ...card, citationCount: undefined }, null, 'feed'), null);
});

test('a notable card without a known notable leaf falls through', () => {
  const card = { ...paper, journal: 'Nature', _notable: true, citationCount: 4200 };
  for (const lanes of [undefined, ['Nature', 'cs', 'cs.unknown']]) {
    const unproven = { ...card, _fetchedFor: lanes };
    assert.equal(feedReason(unproven, null, 'feed'), null);
    assert.equal(feedReason(scored(unproven, { userPreferences: ['cs.LG'] }), null, 'feed')?.text, 'In your area');
  }
});

test('similarity names only the interactions behind the request', () => {
  const close = { ...paper, _semanticScore: 0.675 };
  function label(kinds: Paper['_semanticExampleKinds']) {
    return feedReason(scored({ ...close, _semanticExampleKinds: kinds }, { hasFeedPlan: true, userPreferences: ['cs.LG'] }), null, 'feed')?.text;
  }
  assert.equal(label(['liked']), 'Similar to papers you liked');
  assert.equal(label(['saved']), 'Similar to papers you saved');
  assert.equal(label(['liked', 'saved']), 'Similar to papers you liked or saved');
  assert.equal(label(['liked', 'saved', 'read']), 'Similar to papers you engaged with');
  assert.equal(label(['read']), 'Similar to papers you engaged with');
  const oldSnapshot = { ...close, _debugScore: { corpusSimilarity: 80, exampleKinds: ['saved'] as const } };
  assert.equal(feedReason(oldSnapshot, null, 'feed'), null);
});

test('no similarity label without a plan, or with a weak, outweighed or graph match', () => {
  const inArea = { userPreferences: ['cs.LG'], hasFeedPlan: true };
  const close = { ...paper, _semanticScore: 0.8, _semanticExampleKinds: ['liked'] as const };
  assert.equal(feedReason(scored(close, { ...inArea, hasFeedPlan: false }), null, 'feed')?.kind, 'area');
  assert.equal(feedReason(scored({ ...close, _semanticScore: 0.1 }, inArea), null, 'feed')?.kind, 'area');
  const weighted = scored({ ...close, _semanticScore: 0.45 }, { ...inArea, weights: { maxCorpusSimilarity: 200 } });
  assert.equal(feedReason(weighted, null, 'feed')?.kind, 'area');
  const outweighed = scored({ ...close, authors: ['Ada Lovelace'] }, { ...inArea, followedAuthors: ['Ada Lovelace'], weights: { maxCorpusSimilarity: 50 } });
  assert.equal(feedReason(outweighed, null, 'feed')?.kind, 'area');
  assert.equal(feedReason(scored({ ...close, _isGraphCandidate: true }, inArea), null, 'feed')?.kind, 'area');
});

test('only a scored card of a chosen area has the area reason', () => {
  assert.deepEqual(feedReason(scored(paper, { userPreferences: ['cs.LG'] }), null, 'feed'), { kind: 'area', text: 'In your area' });
  assert.equal(feedReason(scored(paper, { userPreferences: ['math.NT'] }), null, 'feed'), null);
  assert.equal(feedReason(paper, null, 'feed'), null);
  assert.equal(feedReason({ _debugScore: { preference: 100 } }, null, 'feed'), null);
});

test('a cross-listed paper names the first picked lane, then the first picked secondary category', () => {
  const card = { ...paper, primaryCategory: 'hep-th', categories: ['hep-th', 'cs.RO', 'cs.LG'] };
  const picks = { userPreferences: ['cs.LG', 'cs.RO', 'cs.unknown'] };
  const reason = (_fetchedFor: string[]) => feedReason(scored({ ...card, _fetchedFor }, picks), null, 'feed');
  assert.deepEqual(reason(['cs.CV', 'cs.unknown', 'cs.LG', 'cs.RO']), { kind: 'area', text: 'Also in Machine Learning' });
  assert.deepEqual(reason(['cs.CV', 'cs.unknown']), { kind: 'area', text: 'Also in Robotics' });
});

test('an OpenAlex primary topic in a picked leaf counts as the reader’s area', () => {
  const card = scored({ primaryTopic: { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing' }, _fetchedFor: ['bio.gen'] },
    { userPreferences: ['bio.gen', 'bio.mol'] });
  assert.deepEqual(feedReason(card, null, 'feed'), { kind: 'area', text: 'In your area' });
});

test('a picked category without a taxonomy label gives no reason', () => {
  const picks = { userPreferences: ['cs.unknown'] };
  const card = { primaryCategory: 'hep-th', categories: ['hep-th', 'cs.unknown'], _fetchedFor: ['cs.unknown'] };
  assert.equal(feedReason(scored(card, picks), null, 'feed'), null);
  assert.equal(feedReason(scored({ primaryCategory: 'cs.unknown' }, picks), null, 'feed'), null);
});
