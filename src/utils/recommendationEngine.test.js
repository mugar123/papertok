import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeRecommendationWeights,
  scorePaperForRecommendation,
  weightedShuffle,
} from './recommendationEngine.js';

const NOW = new Date('2026-07-05T12:00:00Z').getTime();

test('selected user category dominates neutral papers', () => {
  const score = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.AI',
      allCategories: ['cs.AI'],
      published: '2026-07-05T00:00:00Z',
      authors: ['A. Researcher'],
    },
    {
      now: NOW,
      userPreferences: ['cs.AI'],
    }
  );

  assert.equal(score.preference, 100);
  assert.ok(score.total > 100);
  assert.match(score.explanation, /preference/);
});

test('cooldown suppresses recently rejected categories', () => {
  const noCooldown = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.LG',
      allCategories: ['cs.LG'],
      published: '2026-07-05T00:00:00Z',
    },
    {
      now: NOW,
      userPreferences: ['cs.LG'],
    }
  );

  const cooledDown = scorePaperForRecommendation(
    {
      id: 'paper-b',
      primaryCategory: 'cs.LG',
      allCategories: ['cs.LG'],
      published: '2026-07-05T00:00:00Z',
    },
    {
      now: NOW,
      userPreferences: ['cs.LG'],
      categoryCooldowns: {
        'cs.LG': NOW,
      },
    }
  );

  assert.equal(cooledDown.cooldownMultiplier, 0.1);
  assert.ok(cooledDown.total < noCooldown.total);
});

test('semantic and citation signals contribute to score', () => {
  const score = scorePaperForRecommendation(
    {
      id: 'paper-a',
      primaryCategory: 'cs.CL',
      published: '2025-01-01T00:00:00Z',
      openAlex: {
        cited_by_count: 99,
        concepts: [{ id: 'concept-1', score: 0.5 }],
      },
    },
    {
      now: NOW,
      conceptAffinities: { 'concept-1': 2 },
    }
  );

  assert.ok(score.semantic > 0);
  assert.ok(score.citations > 0);
  assert.match(score.explanation, /semantic|citations/);
});

test('weighted shuffle honors deterministic random selection', () => {
  const papers = [
    { id: 'low', _dynamicScore: 0, _type: 'exploration' },
    { id: 'high', _dynamicScore: 100, _type: 'exploit' },
  ];

  const shuffled = weightedShuffle(
    papers,
    mergeRecommendationWeights(),
    () => 0.99
  );

  assert.equal(shuffled[0].id, 'high');
  assert.deepEqual(new Set(shuffled.map((paper) => paper.id)), new Set(['low', 'high']));
});
