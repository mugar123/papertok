import { useEffect, useRef, useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '../ui/alert-dialog.tsx';
import { Button } from '../ui/button.tsx';
import { actionStart, toastError } from '../ui/toast.ts';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { usePopupOpenOnMount } from '../../hooks/use-popup-open-on-mount.ts';
import { forgetCustomFeedPagesOf } from '../../utils/custom-feed-pages.ts';
import { forgetDismissed } from '../../utils/custom-feed-dismissed.ts';
import { DELETE_FEED_SENTENCE, deleteFeedTitle } from '../../utils/feed-tab-menu.ts';
import './delete-feed-dialog.css';

const COPY = {
  cancel: 'Cancel',
  confirm: 'Delete feed',
  failed: 'The feed could not be deleted',
  tryAgain: 'Try again.',
};

/**
 * Asks before a feed is deleted, from its tab's menu or from Settings ›
 * Feeds. The provider mounts it for each request and unmounts it once it has
 * closed, so it holds its own `open` and reports from
 * `onOpenChangeComplete(false)`, after the leave has played (design.md,
 * Traps). The feed is read once, when it opens: one already deleted on
 * another device has nothing to confirm, and the window does not open.
 *
 * While the deletion runs both buttons wait and nothing closes the window.
 * Deleted, the window closes; what this device kept of the feed (the papers
 * the reader removed from it, its pages for the session) is forgotten, the
 * provider says so, and focus goes to `focusAfterDelete` when the asker gave
 * one; if the feed is open, its page goes to For you by itself. Refused, the
 * feed stays, the window stays open with both buttons ready again, and a
 * toast says so at once.
 */
export default function DeleteFeedDialog({ feedId, uid, focusAfterDelete, onDeleted, onClosed }: {
  feedId: string;
  uid: string;
  focusAfterDelete?: () => HTMLElement | null;
  onDeleted: (name: string) => void;
  onClosed: () => void;
}) {
  const { feeds, deleteFeed } = useCustomFeeds();
  const [feed] = useState(() => feeds.find(entry => entry.id === feedId) ?? null);
  const { open, requestClose } = usePopupOpenOnMount();
  const [busy, setBusy] = useState(false);
  // A ref as well as `busy`: two presses can land before React re-renders.
  const inFlight = useRef(false);
  const deleted = useRef(false);

  useEffect(() => {
    if (!feed) onClosed();
  }, [feed, onClosed]);

  if (!feed) return null;

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const startedAt = actionStart();
    try {
      await deleteFeed(feed.id);
      forgetDismissed(uid, feed.id);
      forgetCustomFeedPagesOf(uid, feed.id);
      deleted.current = true;
      onDeleted(feed.name);
      requestClose();
    } catch (error) {
      console.error('The feed could not be deleted', error);
      inFlight.current = false;
      setBusy(false);
      toastError(COPY.failed, { description: COPY.tryAgain, startedAt });
    }
  };

  // After a deletion, the asker's target; otherwise (and when it finds
  // nothing) back where the window was opened from.
  const finalFocus = () => (deleted.current && focusAfterDelete?.()) || true;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !inFlight.current) requestClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <AlertDialogContent className="delete-feed-dialog" aria-busy={busy || undefined} finalFocus={finalFocus}>
        <AlertDialogTitle render={<h2 />}>{deleteFeedTitle(feed.name)}</AlertDialogTitle>
        <AlertDialogDescription>{DELETE_FEED_SENTENCE}</AlertDialogDescription>
        <div className="delete-feed-actions">
          <Button variant="outline" disabled={busy} focusableWhenDisabled onClick={() => { if (!inFlight.current) requestClose(); }}>{COPY.cancel}</Button>
          <Button
            variant="destructive"
            disabled={busy}
            focusableWhenDisabled
            aria-busy={busy || undefined}
            onClick={() => { void confirm(); }}
          >
            {COPY.confirm}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
