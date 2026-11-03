import { MAX_FOLLOWED_JOURNALS } from '../../utils/following.ts';

/**
 * What the Journals tab says when the reader follows more journals than the
 * feeds read, or null. The app refuses an eleventh journal, but two devices
 * following at once can store one, since Firestore rules cannot count them
 * (Pablo, 2026-10-26), and the feeds then read only the first ten.
 */
export function journalLimitNote(journalCount: number) {
  if (journalCount <= MAX_FOLLOWED_JOURNALS) return null;
  const excess = journalCount - MAX_FOLLOWED_JOURNALS;
  return `You follow ${journalCount} journals, and only ${MAX_FOLLOWED_JOURNALS} add papers to your feeds. Unfollow ${excess === 1 ? 'one' : excess} so that all of them do.`;
}
