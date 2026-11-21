import type { InterestSettings } from './area-preferences.ts';
import type { normalizeReadingPreferences } from './user-settings.ts';

export function onboardingProfileWrite(
  preferences: string[],
  settings: InterestSettings,
  readingPreferences: ReturnType<typeof normalizeReadingPreferences> | null,
) {
  return {
    onboardingComplete: true,
    ...(readingPreferences ? { readingPreferences } : {}),
    preferences,
    ...settings,
  };
}

export function interestPreferencesWrite(
  preferences: string[],
  deselectedPreferences: string[],
  addedPreferences: string[],
  settings: InterestSettings,
  previousSettings: InterestSettings,
) {
  return {
    preferences,
    deselectedPreferences,
    addedPreferences,
    ...settings,
    ...(previousSettings.areaPreferences && !settings.areaPreferences ? { areaPreferences: {} } : {}),
  };
}
