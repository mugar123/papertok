/**
 * Whether a `users/{uid}` document already chose interests.
 *
 * `onboardingComplete` is the flag `completeOnboarding` writes. Older or
 * partial documents sometimes have `preferences` / `selectedCategories` and
 * no flag, which is what sent a returning account back through the interest
 * picker as if they were new.
 */
export function accountLooksOnboarded(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.onboardingComplete === true) return true;
  const prefs = data.preferences ?? data.selectedCategories;
  return Array.isArray(prefs) && prefs.length > 0;
}

/**
 * The most preferences a `users/{uid}` document may hold. The number is the
 * rules' (`firestore.rules`, `preferences.size() <= 100`): a longer list is
 * refused by the server, and a refusal the pickers do not prevent surfaces as
 * "could not save" at best — and, before the write order in AuthContext was
 * fixed, as an onboarding that came back on every reload
 * (docs/AUDITORIA-ONBOARDING-INTERESES-2026-09-16.md, hallazgo 4). The guest
 * seed stays far below it (58 for all twelve areas); "select all" twelve
 * times does not (142).
 */
export const USER_PREFERENCES_MAX = 100;
