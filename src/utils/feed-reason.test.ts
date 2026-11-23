import assert from 'node:assert/strict';
import test from 'node:test';

import type { Paper } from '../models/paper.ts';
import { scorePaperForRecommendation } from './recommendation-engine.ts';
import { feedReason } from './feed-reason.ts';
import { getPaperClassification } from './paper-topic-tags.ts';
import { followedOnCard } from './follow-reasons.ts';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

function scored(paper: Partial<Paper>, context: Parameters<typeof scorePaperForRecommendation>[1] = {}) {
  return { ...paper, _debugScore: scorePaperForRecommendation(paper, { now: NOW, ...context }) };
}

function reason(card: Partial<Paper>, followed: ReturnType<typeof followedOnCard>, surface: string) {
  return feedReason(card, followed, surface, getPaperClassification(card).label);
}

const paper: Partial<Paper> = {
  id: 'p1',
  primaryCategory: 'cs.LG',
  categories: ['cs.LG'],
  published: '2026-11-20',
  abstract: 'A long enough abstract about learning representations from data, with methods and results described in it.',
};

const yann = { name: 'Yann LeCun', id: 'A123' };
const authorLane = { type: 'author' as const, canonicalId: yann.id, displayName: yann.name };
const authorOnCard = followedOnCard([], yann, () => true);

test('the request can explain a follow only on the surface that used it', () => {
  const fromRequest = followedOnCard([authorLane], yann, () => true);
  const topic = followedOnCard([{ type: 'topic', canonicalId: 'T123', displayName: 'T123' }], null, () => true);
  for (const surface of ['feed', 'following']) {
    assert.equal(reason(paper, fromRequest, surface)?.text, 'Because you follow Yann LeCun');
    assert.equal(reason(paper, topic, surface)?.text, 'Because you follow this topic');
    assert.equal(reason(paper, authorOnCard, surface)?.text, 'You follow Yann LeCun');
  }
  for (const surface of ['custom_feed', 'recent', 'search', 'lists', 'explorer', 'other', 'connections', 'similar']) {
    assert.equal(reason(paper, fromRequest, surface)?.text, 'You follow Yann LeCun');
    assert.equal(reason(paper, null, surface), null);
  }
});

test('a score boost alone does not credit a follow with fetching the card', () => {
  const card = { ...paper, authors: [yann, { name: 'Ada Lovelace' }] };
  const ranked = scored(card, { followedEntities: [authorLane] });
  assert.ok(ranked._debugScore.followBoost > 0);
  assert.equal(reason(ranked, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
  assert.equal(reason(ranked, authorOnCard, 'custom_feed')?.text, 'You follow Yann LeCun');
  assert.equal(reason(ranked, authorOnCard, 'recent')?.text, 'You follow Yann LeCun');
  assert.equal(reason({ ...ranked, _notable: true }, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
  const otherAuthor = scored(card, { followedAuthors: ['Ada Lovelace'] });
  assert.equal(reason(otherAuthor, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
  const capped = scored(card, { followedEntities: [authorLane], weights: { maxFollowBoost: 0 } });
  assert.equal(reason(capped, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
  const topicBoost = scored(card, { followedEntities: [{ type: 'topic', canonicalId: 'cs.LG' }] });
  assert.equal(reason(topicBoost, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
});

test('a highly cited card names its notable leaf even if its own classification differs', () => {
  const card = scored({ ...paper, primaryCategory: 'cs.CV', _notable: true, citationCount: 100, _fetchedFor: ['cs.LG', 'cs.AI'] },
    { userPreferences: ['cs.CV'] });
  assert.deepEqual(reason(card, null, 'feed'), { kind: 'classic', text: 'Highly cited in Machine Learning' });
  assert.equal(reason(card, authorOnCard, 'feed')?.text, 'Highly cited in Machine Learning');
  assert.equal(reason({ ...card, citationCount: 99 }, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
  assert.equal(reason({ ...card, citationCount: 99 }, null, 'feed'), null);
  assert.equal(reason({ ...card, citationCount: undefined }, null, 'feed'), null);
});

test('a notable card without a known notable leaf has only a follow fact, if any', () => {
  const card = { ...paper, journal: 'Nature', _notable: true, citationCount: 4200 };
  for (const lanes of [undefined, ['Nature', 'cs', 'cs.unknown']]) {
    const unproven = { ...card, _fetchedFor: lanes };
    assert.equal(reason(unproven, null, 'feed'), null);
    assert.equal(reason(unproven, authorOnCard, 'feed')?.text, 'You follow Yann LeCun');
    assert.equal(reason(scored(unproven, { userPreferences: ['cs.LG'] }), null, 'feed'), null);
  }
});

test('similarity names only the interactions behind the request', () => {
  const close = { ...paper, _semanticScore: 0.675 };
  function label(kinds: Paper['_semanticExampleKinds']) {
    return reason(scored({ ...close, _semanticExampleKinds: kinds }, { userPreferences: ['cs.LG'] }), null, 'feed')?.text;
  }
  assert.equal(label(['liked']), 'Similar to papers you liked');
  assert.equal(label(['saved']), 'Similar to papers you saved');
  assert.equal(label(['liked', 'saved']), 'Similar to papers you liked or saved');
  assert.equal(label(['liked', 'saved', 'read']), 'Similar to papers you engaged with');
  assert.equal(label(['read']), 'Similar to papers you engaged with');
  assert.equal(label(undefined), 'In your area');
});

test('no similarity label for a weak, outweighed or graph match', () => {
  const inArea = { userPreferences: ['cs.LG'] };
  const close = { ...paper, _semanticScore: 0.8, _semanticExampleKinds: ['liked'] as const };
  assert.equal(reason(scored({ ...close, _semanticScore: 0.1 }, inArea), null, 'feed')?.kind, 'area');
  const weighted = scored({ ...close, _semanticScore: 0.45 }, { ...inArea, weights: { maxCorpusSimilarity: 200 } });
  assert.equal(reason(weighted, null, 'feed')?.kind, 'area');
  const outweighed = scored({ ...close, authors: ['Ada Lovelace'] }, { ...inArea, followedAuthors: ['Ada Lovelace'], weights: { maxCorpusSimilarity: 50 } });
  assert.equal(reason(outweighed, null, 'feed')?.kind, 'area');
  assert.equal(reason(scored({ ...close, _isGraphCandidate: true }, inArea), null, 'feed')?.kind, 'area');
});

test('only a scored card of a chosen area has the area reason', () => {
  assert.deepEqual(reason(scored(paper, { userPreferences: ['cs.LG'] }), null, 'feed'), { kind: 'area', text: 'In your area' });
  assert.equal(reason(scored(paper, { userPreferences: ['math.NT'] }), null, 'feed'), null);
  assert.equal(reason(paper, null, 'feed'), null);
  assert.equal(reason({ _debugScore: { preference: 100 } }, null, 'feed'), null);
});

test('a cross-listed paper names the first picked lane, then the first picked secondary category', () => {
  const card = { ...paper, primaryCategory: 'hep-th', categories: ['hep-th', 'cs.RO', 'cs.LG'] };
  const picks = { userPreferences: ['cs.LG', 'cs.RO', 'cs.unknown'] };
  const fromLanes = (_fetchedFor: string[]) => reason(scored({ ...card, _fetchedFor }, picks), null, 'feed');
  assert.deepEqual(fromLanes(['cs.CV', 'cs.unknown', 'cs.LG', 'cs.RO']), { kind: 'area', text: 'Also in Machine Learning' });
  assert.deepEqual(fromLanes(['cs.CV', 'cs.unknown']), { kind: 'area', text: 'Also in Robotics' });
});

test('a picked cross-list with the displayed field name reads In your area', () => {
  for (const [primary, picked] of [['cs.LG', 'stat.ML'], ['stat.ML', 'cs.LG']]) {
    const card = scored({ ...paper, primaryCategory: primary, categories: [primary, picked] }, { userPreferences: [picked] });
    assert.equal(reason(card, null, 'feed')?.text, 'In your area');
  }
});

test('an OpenAlex primary topic in a picked leaf counts as the reader’s area', () => {
  const card = scored({ primaryTopic: { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing' }, _fetchedFor: ['bio.gen'] },
    { userPreferences: ['bio.gen', 'bio.mol'] });
  assert.deepEqual(reason(card, null, 'feed'), { kind: 'area', text: 'In your area' });
});

test('a picked category without a taxonomy label gives no reason', () => {
  const picks = { userPreferences: ['cs.unknown'] };
  const card = { primaryCategory: 'hep-th', categories: ['hep-th', 'cs.unknown'], _fetchedFor: ['cs.unknown'] };
  assert.equal(reason(scored(card, picks), null, 'feed'), null);
  assert.equal(reason(scored({ primaryCategory: 'cs.unknown' }, picks), null, 'feed'), null);
});
