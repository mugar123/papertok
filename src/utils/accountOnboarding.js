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
