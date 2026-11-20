import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInterestSettings, priorityForArea, resolveReadingLevel } from './area-preferences.ts';
import { normalizeReadingPreferences } from './user-settings.ts';

test('a profile saved before area preferences uses Essential and its global reading level', () => {
  const profile = { readingPreferences: { aiExplanationLevel: 'researcher' } };
  const settings = normalizeInterestSettings();
  assert.deepEqual(settings, {});
  assert.equal(priorityForArea(settings, 'physics'), 'essential');
  assert.equal(resolveReadingLevel({ primaryCategory: 'quant-ph' }, settings, undefined,
    normalizeReadingPreferences(profile.readingPreferences).aiExplanationLevel), 'researcher');
});

test('an explicit reading level wins over the paper area, then the global default applies', () => {
  const settings = normalizeInterestSettings({ areaPreferences: { ai: { level: 'beginner' } } });
  assert.equal(resolveReadingLevel({ primaryCategory: 'cs.AI' }, settings, 'researcher', 'university'), 'researcher');
  assert.equal(resolveReadingLevel({ primaryCategory: 'cs.AI', categories: ['math.AG'] }, settings, undefined, 'researcher'), 'beginner');
  assert.equal(resolveReadingLevel({ primaryCategory: 'math.AG' }, settings, undefined, 'researcher'), 'researcher');
  assert.equal(resolveReadingLevel({}, settings), 'university');
});

test('only known areas and valid settings for selected areas survive normalization', () => {
  assert.deepEqual(normalizeInterestSettings({
    interestMix: 'unknown',
    areaPreferences: {
      physics: { priority: 'curiosity', level: 'invalid' },
      math: { priority: 'maybe', level: 'beginner' },
      econ: { level: 'researcher' },
      'cs.AI': { priority: 'curiosity' },
    },
  }, ['physics', 'math', 'cs.AI']), {
    areaPreferences: { physics: { priority: 'curiosity' }, math: { level: 'beginner' } },
  });
});
