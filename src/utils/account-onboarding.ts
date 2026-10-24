/**
 * Whether a `users/{uid}` document already chose interests.
 *
 * `onboardingComplete` is the flag `completeOnboarding` writes. Older or
 * partial documents sometimes have `preferences` / `selectedCategories` and
 * no flag, which is what sent a returning account back through the interest
 * picker as if they were new.
 */
export function accountLooksOnboarded(data: { onboardingComplete?: unknown; preferences?: unknown; selectedCategories?: unknown } | null | undefined) {
  if (!data || typeof data !== 'object') return false;
  if (data.onboardingComplete === true) return true;
  const prefs = data.preferences ?? data.selectedCategories;
  return Array.isArray(prefs) && prefs.length > 0;
}

/**
 * The most preferences a `users/{uid}` document may hold. The number is the
 * rules' (`firestore.rules`, `preferences.size() <= 100`): a longer list is
 * refused by the server, so pickers and the guest seed must stay within it.
 */
export const USER_PREFERENCES_MAX = 100;
