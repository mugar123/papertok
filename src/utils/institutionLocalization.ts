function getLocalizedNames(institution = {}) {
  return institution?.localized_names
    || institution?.localizedNames
    || institution?.metadata?.localizedNames
    || {};
}

export function getLocalizedInstitutionName(institution = {}) {
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
