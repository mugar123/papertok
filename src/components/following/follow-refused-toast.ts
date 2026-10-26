import { toastError } from '../ui/toast.ts';
import { FollowsUnavailableError, JournalFollowLimitError, MAX_FOLLOWED_JOURNALS } from '../../utils/following.ts';

/**
 * Says why a press of Follow or Unfollow changed nothing, when `toggleFollow`
 * rejects. The toast stays until it is closed: the toast region comes before
 * the page in the tab order, so a keyboard reaches its action only through
 * the region's hotkey, and a toast that left after 4 s took the action and a
 * 25-word message with it (WCAG 2.2.1).
 */
export function toastFollowRefused(error: unknown, { name, following, openSettings }: {
  name: string;
  // Whether the press was an Unfollow.
  following: boolean;
  // Where a reader at the journal limit unfollows one; left out on the follows settings themselves.
  openSettings?: () => void;
}) {
  if (error instanceof JournalFollowLimitError) {
    return toastError(`You already follow ${MAX_FOLLOWED_JOURNALS} journals, the most you can. Unfollow one in Settings to follow ${name}.`, {
      action: openSettings && { label: 'Open Settings', onClick: openSettings },
    });
  }
  if (error instanceof FollowsUnavailableError) {
    // A snapshot error ends the listener, so trying again cannot help; a
    // reload attaches a new one.
    if (error.retryable) return toastError(`Your follows have not loaded yet, so ${name} was not followed. Try again in a moment.`);
    return toastError(`Your follows could not be loaded, so ${name} was not followed. Reload the page to try again.`, {
      action: { label: 'Reload', onClick: () => { window.location.reload(); } },
    });
  }
  // A write Firestore refused, such as a journal follow before the rules that
  // accept journals are deployed, or a dropped connection.
  console.error(error);
  return toastError(`Could not ${following ? 'unfollow' : 'follow'} ${name}. Try again.`);
}
