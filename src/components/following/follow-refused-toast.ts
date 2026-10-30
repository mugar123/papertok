import type { FollowInput } from '../../utils/following.ts';
import { toastError } from '../ui/toast.ts';
import { createFollowEntity, FollowsUnavailableError, JournalFollowLimitError, MAX_FOLLOWED_JOURNALS } from '../../utils/following.ts';

type RefusalContext = {
  name: string;
  // Whether the press was an Unfollow.
  following: boolean;
  // Where a reader at the journal limit unfollows one; left out on the follows settings themselves.
  openSettings?: () => void;
};

// Not taken from following-context.tsx: importing it type-checks the feed
// components in the test project, whose Node types make setTimeout return a Timeout.
type FollowCalls = {
  isFollowing: (entity: FollowInput) => boolean;
  toggleFollow: (entity: FollowInput) => Promise<boolean>;
};

export type FollowRefusal = {
  message: string;
  action?: { label: string; onClick: () => void };
};

/**
 * Says why a press of Follow or Unfollow changed nothing, when `toggleFollow`
 * rejects: the words, and the one thing the reader can do about it. A page
 * shows it in a toast (`toastFollowRefused`); the search palette and the
 * Follows list show it in a line of their own, because on a phone they are
 * sheets, and a toast sits over their first rows, outside their focus trap,
 * where Escape closes the sheet instead.
 */
export function followRefusal(error: unknown, { name, following, openSettings }: RefusalContext): FollowRefusal {
  if (error instanceof JournalFollowLimitError) {
    // Two devices following at once can store more than the limit.
    const excess = error.followed - MAX_FOLLOWED_JOURNALS;
    const message = excess > 0
      ? `You follow ${error.followed} journals, more than the ${MAX_FOLLOWED_JOURNALS} you can. Unfollow ${excess + 1} in Settings to follow ${name}.`
      : `You already follow ${MAX_FOLLOWED_JOURNALS} journals, the most you can. Unfollow one in Settings to follow ${name}.`;
    return openSettings ? { message, action: { label: 'Open Settings', onClick: openSettings } } : { message };
  }
  if (error instanceof FollowsUnavailableError) {
    // A snapshot error ends the listener, so trying again cannot help; a
    // reload attaches a new one.
    if (error.retryable) return { message: `Your follows have not loaded yet, so ${name} was not followed. Try again in a moment.` };
    return {
      message: `Your follows could not be loaded, so ${name} was not followed. Reload the page to try again.`,
      action: { label: 'Reload', onClick: () => { window.location.reload(); } },
    };
  }
  // A write Firestore refused, such as a journal follow before the rules that
  // accept journals are deployed, or a dropped connection.
  console.error(error);
  return { message: `Could not ${following ? 'unfollow' : 'follow'} ${name}. Try again.` };
}

/**
 * The name a refusal gives what was pressed. Each surface fills a different
 * field (`displayName`, `display_name` or `name`); the follow saved reads them
 * in that order, so the refusal does too.
 */
export function followName(entity: FollowInput) {
  return createFollowEntity(entity)?.displayName || 'this';
}

/**
 * Presses Follow or Unfollow on `entity` and resolves to why nothing changed,
 * or to null once it changed.
 */
export async function toggleFollowOrRefusal(entity: FollowInput, { isFollowing, toggleFollow }: FollowCalls) {
  const following = isFollowing(entity);
  try {
    await toggleFollow(entity);
    return null;
  } catch (error) {
    return followRefusal(error, { name: followName(entity), following });
  }
}

/**
 * `followRefusal` in a toast that stays until it is closed: the toast region
 * comes before the page in the tab order, so Tab from the button never
 * reaches its action, and a toast that left after 4 s took the action and a
 * 25-word message with it before a keyboard or screen-reader user could get
 * there (WCAG 2.2.1).
 */
export function toastFollowRefused(error: unknown, context: RefusalContext & { overlaysAtStart?: number }) {
  const { message, action } = followRefusal(error, context);
  return toastError(message, { action, overlaysAtStart: context.overlaysAtStart });
}
