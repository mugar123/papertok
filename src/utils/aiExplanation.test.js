import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_EXPLANATION_LEVELS,
  AIExplanationError,
  buildPaperExplanationPrompt,
  normalizePaperForExplanation,
} from '../../worker/ai-explanation.js';

test('supports the three explanation depths', () => {
  assert.deepEqual(AI_EXPLANATION_LEVELS, ['beginner', 'university', 'researcher']);
});

test('builds a source-aware prompt without silently claiming full-text access', () => {
  const paper = normalizePaperForExplanation({ title: 'A test', abstract: 'Known facts.' });
  const prompt = buildPaperExplanationPrompt(paper, 'university', 'abstract');
  assert.match(prompt, /Solo dispones del abstract/);
  assert.match(prompt, /Known facts/);
  assert.match(prompt, /LaTeX/);
  assert.match(prompt, /\$\.\.\.\$/);
  assert.match(prompt, /nunca escribas ω_b/);
  assert.match(prompt, /keyPoints/);
});

test('rejects an explanation request without usable paper content', () => {
  assert.throws(
    () => normalizePaperForExplanation({ title: 'No content' }),
    error => error instanceof AIExplanationError && error.code === 'AI_INVALID_PAPER',
  );
});
