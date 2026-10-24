import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_READING_PREFERENCES,
  normalizeReadingPreferences,
} from './user-settings.ts';

test('normalizes the preferred AI explanation level', () => {
  assert.deepEqual(normalizeReadingPreferences({ aiExplanationLevel: 'researcher' }), {
    aiExplanationLevel: 'researcher',
    language: 'en',
    languagePreferenceSet: false,
  });
  assert.deepEqual(normalizeReadingPreferences({ aiExplanationLevel: 'unknown' }), {
    aiExplanationLevel: DEFAULT_READING_PREFERENCES.aiExplanationLevel,
    language: 'en',
    languagePreferenceSet: false,
  });
});

test('normalizes the interface language', () => {
  assert.deepEqual(normalizeReadingPreferences({ language: 'en' } as NonNullable<Parameters<typeof normalizeReadingPreferences>[0]> & Record<string, unknown>), {
    aiExplanationLevel: DEFAULT_READING_PREFERENCES.aiExplanationLevel,
    language: 'en',
    languagePreferenceSet: false,
  });
  assert.equal(normalizeReadingPreferences({ language: 'fr' } as NonNullable<Parameters<typeof normalizeReadingPreferences>[0]> & Record<string, unknown>).language, 'en');
});

test('keeps track of whether the language was selected manually', () => {
  assert.equal(normalizeReadingPreferences({ language: 'en' } as NonNullable<Parameters<typeof normalizeReadingPreferences>[0]> & Record<string, unknown>).languagePreferenceSet, false);
  assert.equal(normalizeReadingPreferences({ language: 'en', languagePreferenceSet: true } as NonNullable<Parameters<typeof normalizeReadingPreferences>[0]> & Record<string, unknown>).languagePreferenceSet, true);
});
