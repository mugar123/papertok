import { USER_PREFERENCES_MAX } from '../../utils/accountOnboarding.ts';

/**
 * Why the interests editor refuses to save this many interests, or null when
 * it may write them. Checked before the write, so a saved profile never holds
 * more than USER_PREFERENCES_MAX.
 */
export function interestsSaveRefusal(count: number) {
  if (count === 0) return 'Select at least one research area.';
  if (count > USER_PREFERENCES_MAX) return `At most ${USER_PREFERENCES_MAX} interests: drop ${count - USER_PREFERENCES_MAX}.`;
  return null;
}
