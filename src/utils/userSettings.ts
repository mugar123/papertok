export const DEFAULT_READING_PREFERENCES = Object.freeze({
  aiExplanationLevel: 'university',
  language: 'en',
  languagePreferenceSet: false,
});

const AI_EXPLANATION_LEVEL_IDS = new Set(['beginner', 'university', 'researcher']);

export function normalizeReadingPreferences(value = {}) {
  const aiExplanationLevel = AI_EXPLANATION_LEVEL_IDS.has(value?.aiExplanationLevel)
    ? value.aiExplanationLevel
    : DEFAULT_READING_PREFERENCES.aiExplanationLevel;
  // English only. The field stays in the stored shape (the rules validate it),
  // but a profile saved as 'es' before the switch reads as English.
  const language = DEFAULT_READING_PREFERENCES.language;
  const languagePreferenceSet = value?.languagePreferenceSet === true;

  return { aiExplanationLevel, language, languagePreferenceSet };
}
