export type ReadingLevel = 'beginner' | 'university' | 'researcher';

export const DEFAULT_READING_PREFERENCES = Object.freeze({
  aiExplanationLevel: 'university' as ReadingLevel,
  language: 'en',
  languagePreferenceSet: false,
});

const AI_EXPLANATION_LEVEL_IDS = new Set<unknown>(['beginner', 'university', 'researcher']);

export function normalizeReadingPreferences(value: { aiExplanationLevel?: unknown; languagePreferenceSet?: unknown } | null = {}) {
  const aiExplanationLevel = AI_EXPLANATION_LEVEL_IDS.has(value?.aiExplanationLevel)
    ? value!.aiExplanationLevel as ReadingLevel
    : DEFAULT_READING_PREFERENCES.aiExplanationLevel;
  // English only. The field stays in the stored shape (the rules validate it),
  // but a profile saved as 'es' before the switch reads as English.
  const language = DEFAULT_READING_PREFERENCES.language;
  const languagePreferenceSet = value?.languagePreferenceSet === true;

  return { aiExplanationLevel, language, languagePreferenceSet };
}
