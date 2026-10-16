import type { PaperInstitution } from '../models/Paper.ts';

export interface LocalizedInstitution extends PaperInstitution {
  name?: string;
  localized_names?: Record<string, string>;
  localizedNames?: Record<string, string>;
  metadata?: { localizedNames?: Record<string, string> };
}

function getLocalizedNames(institution: LocalizedInstitution | null = {}) {
  return institution?.localized_names
    || institution?.localizedNames
    || institution?.metadata?.localizedNames
    || {};
}

export function getLocalizedInstitutionName(institution: LocalizedInstitution | null = {}) {
  const safeInstitution = institution || {};
  const localizedNames = getLocalizedNames(institution);
  const languageKey = 'en';
  const localizedName = String(localizedNames[languageKey] || '').trim();
  const officialName = String(
    safeInstitution.display_name
      || safeInstitution.displayName
      || safeInstitution.name
      || '',
  ).trim();

  return localizedName || officialName;
}
