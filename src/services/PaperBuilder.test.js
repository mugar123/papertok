import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperBuilder } from './PaperBuilder.js';
import { scorePaperForRecommendation } from '../utils/recommendationEngine.js';

test('normalizes category and publication metadata used by ranking', () => {
  const paper = PaperBuilder.create({
    id: 'arxiv:2607.00001',
    title: 'Optics paper',
    categories: ['physics.optics', 'quant-ph'],
    published: '2026-07-01T00:00:00Z',
    citationsCount: 12,
    authors: [{ name: 'Ada Researcher' }],
  });

  assert.equal(paper.primaryCategory, 'physics.optics');
  assert.deepEqual(paper.allCategories, ['physics.optics', 'quant-ph']);
  assert.equal(paper.published, '2026-07-01T00:00:00Z');
  assert.equal(paper.citationCount, 12);

  const score = scorePaperForRecommendation(paper, {
    now: new Date('2026-07-02T00:00:00Z').getTime(),
    userPreferences: ['physics.optics'],
    followedAuthors: ['Ada Researcher'],
  });
  assert.equal(score.preference, 100);
  assert.equal(score.authorBoost, 50);
});

test('OpenAlex enrichment remains available to the recommendation engine', () => {
  const paper = PaperBuilder.create({ id: 'arxiv:1', title: 'Paper', publicationType: 'preprint' });
  const enriched = PaperBuilder.merge(paper, {
    citationCount: 42,
    concepts: [{ id: 'concept-1', score: 0.5 }],
  }, 'openalex');

  const score = scorePaperForRecommendation(enriched, {
    conceptAffinities: { 'concept-1': 1 },
  });

  assert.equal(enriched.openAlex.citationCount, 42);
  assert.ok(score.citations > 0);
  assert.ok(score.semantic > 0);
});
