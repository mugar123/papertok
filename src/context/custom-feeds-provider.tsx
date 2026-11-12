import type { PropsWithChildren } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CustomFeedsContext, type CustomFeedsValue } from './custom-feeds-context.ts';
import DeleteFeedDialog from '../components/custom-feeds/delete-feed-dialog.tsx';
import FeedDialog from '../components/custom-feeds/feed-dialog.tsx';
import { useAuth } from './auth-context.tsx';
import { FIRST_SNAPSHOT_GRACE_MS } from './following-context.tsx';
import { useAnalyticsConsent } from './privacy-context.tsx';
import { changeCustomFeeds, createAnswerTracker, newFeedId, subscribeCustomFeeds } from '../services/custom-feeds-store.ts';
import {
  CustomFeedError,
  customFeedCreateEvent,
  withFeedAdded,
  withFeedChanged,
  withFeedMoved,
  withFeedRemoved,
  type CustomFeed,
  type CustomFeedInput,
} from '../utils/custom-feeds.ts';

type EditorTarget = { feedId?: string; preset?: Partial<CustomFeedInput> };

const NO_FEEDS: CustomFeed[] = [];
const sameFeeds = (a: CustomFeed[], b: CustomFeed[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Shares the signed-in account's custom feeds with the app. Mounted under the
 * account-scoped key in app.tsx, so a different account gets a new provider;
 * the account becoming known on a cold load happens in place, which is why the
 * feeds in hand carry the uid they belong to and count only for that uid.
 *
 * The shown list is the last one the server confirmed: a listener snapshot
 * that is an answer, or the list a write committed when the listener has not
 * answered since that write began. Writes are not shown
 * before they commit, so a failed one has nothing to roll back.
 */
export function CustomFeedsProvider({ children }: PropsWithChildren) {
  const { user, loading: authLoading } = useAuth();
  const uid = user?.uid ?? null;
  const { trackEvent } = useAnalyticsConsent();
  const [answer, setAnswer] = useState<{ uid: string; feeds: CustomFeed[] } | null>(null);
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null);
  // The feed window and the delete confirmation to show, each numbered so
  // each opening mounts a fresh one. A confirmation belongs to the account
  // that asked for it: it is dropped when the account changes, so signing
  // back in does not bring it back unasked.
  const [editor, setEditor] = useState<{ target: EditorTarget; n: number } | null>(null);
  const [deletion, setDeletion] = useState<{ feedId: string; focusAfterDelete?: () => HTMLElement | null; n: number } | null>(null);
  // State adjusted during render, as app.tsx does for the account scope.
  const [deletionUid, setDeletionUid] = useState(uid);
  if (deletionUid !== uid) {
    setDeletionUid(uid);
    setDeletion(null);
  }
  // What the last deletion was, for the status line below; numbered so the
  // same words said twice change the line and are announced again.
  const [deleted, setDeleted] = useState({ text: '', n: 0 });
  const [refreshRequest, setRefreshRequest] = useState<{ tab: string; n: number } | null>(null);
  // `retry` starting the listener again.
  const [listenAttempt, setListenAttempt] = useState(0);
  const [answers] = useState(createAnswerTracker);

  // A list equal to the one shown keeps the old array, so the value below
  // keeps its identity through snapshots that only change metadata.
  const showFeeds = useCallback((owner: string, feeds: CustomFeed[]) => {
    setAnswer(current => (current?.uid === owner && sameFeeds(current.feeds, feeds) ? current : { uid: owner, feeds }));
  }, []);

  useEffect(() => {
    if (!uid) return undefined;
    // No answer within the grace is `unavailable`, not an account without
    // feeds. The listener stays attached, and a later answer still shows.
    const grace = window.setTimeout(() => setUnavailableFor(uid), FIRST_SNAPSHOT_GRACE_MS);
    const unsubscribe = subscribeCustomFeeds(uid, (feeds) => {
      window.clearTimeout(grace);
      answers.answered();
      showFeeds(uid, feeds);
    }, (error) => {
      // An error after an answer keeps that answer on screen.
      window.clearTimeout(grace);
      console.error('Error loading custom feeds', error);
      setUnavailableFor(uid);
    });
    return () => {
      window.clearTimeout(grace);
      unsubscribe();
    };
  }, [uid, showFeeds, answers, listenAttempt]);

  // A listener ended by an error stays closed; this opens a new one and waits
  // again, through the same grace, for its answer.
  const retry = useCallback(() => {
    setUnavailableFor(null);
    setListenAttempt(current => current + 1);
  }, []);

  const confirmed = uid && answer?.uid === uid ? answer.feeds : null;
  const feeds = confirmed ?? NO_FEEDS;
  let status: CustomFeedsValue['status'];
  // While auth has not said whether there is a session, a missing user is not yet a guest.
  if (!uid) status = authLoading ? 'loading' : 'ready';
  else if (confirmed) status = 'ready';
  else status = unavailableFor === uid ? 'unavailable' : 'loading';

  const change = useCallback(async (apply: (current: CustomFeed[]) => CustomFeed[]) => {
    if (!uid) throw new CustomFeedError('invalid');
    const stillLatest = answers.beginWrite();
    const written = await changeCustomFeeds(uid, apply);
    // A listener answer since the write began may hold another device's
    // later write; the list must not go back to this one.
    if (stillLatest()) showFeeds(uid, written);
    return written;
  }, [uid, showFeeds, answers]);

  const createFeed = useCallback(async (input: CustomFeedInput, id: string = newFeedId()) => {
    const written = await change(current => withFeedAdded(current, input, id));
    // changeCustomFeeds writes only a list in which every feed survived parsing.
    const created = written.find(feed => feed.id === id)!;
    void trackEvent('custom_feed_create', customFeedCreateEvent(created));
    return created;
  }, [change, trackEvent]);
  const updateFeed = useCallback(async (id: string, input: CustomFeedInput) => {
    await change(current => withFeedChanged(current, id, input));
  }, [change]);
  const deleteFeed = useCallback(async (id: string) => {
    await change(current => withFeedRemoved(current, id));
    void trackEvent('custom_feed_delete');
  }, [change, trackEvent]);
  const moveFeed = useCallback(async (id: string, delta: -1 | 1) => {
    await change(current => withFeedMoved(current, id, delta));
  }, [change]);

  const openFeedEditor = useCallback((target?: EditorTarget) => {
    setEditor(current => ({ target: target ?? {}, n: (current?.n ?? 0) + 1 }));
  }, []);
  // Only the window that is still the current one clears it: a window still
  // leaving when another opens must not close the new one.
  const closeFeedEditor = useCallback((n: number) => {
    setEditor(current => (current?.n === n ? null : current));
  }, []);
  const confirmDeleteFeed = useCallback((id: string, options?: { focusAfterDelete?: () => HTMLElement | null }) => {
    setDeletion(current => ({ feedId: id, focusAfterDelete: options?.focusAfterDelete, n: (current?.n ?? 0) + 1 }));
  }, []);
  const closeDeletion = useCallback((n: number) => {
    setDeletion(current => (current?.n === n ? null : current));
  }, []);
  const announceDeleted = useCallback((name: string) => {
    setDeleted(current => ({ text: `Deleted ${name}.`, n: current.n + 1 }));
  }, []);
  const requestRefresh = useCallback((tab: string) => {
    setRefreshRequest(current => ({ tab, n: (current?.n ?? 0) + 1 }));
  }, []);

  const value = useMemo<CustomFeedsValue>(() => ({
    feeds,
    status,
    createFeed,
    updateFeed,
    deleteFeed,
    moveFeed,
    openFeedEditor,
    confirmDeleteFeed,
    refreshRequest,
    requestRefresh,
    retry,
  }), [confirmDeleteFeed, createFeed, deleteFeed, feeds, moveFeed, openFeedEditor, refreshRequest, requestRefresh, retry, status, updateFeed]);

  return (
    <CustomFeedsContext.Provider value={value}>
      {children}
      {editor && (
        <FeedDialog
          key={editor.n}
          feedId={editor.target.feedId}
          preset={editor.target.preset}
          onClosed={() => closeFeedEditor(editor.n)}
        />
      )}
      {uid && deletion && (
        <DeleteFeedDialog
          key={deletion.n}
          feedId={deletion.feedId}
          focusAfterDelete={deletion.focusAfterDelete}
          uid={uid}
          onDeleted={announceDeleted}
          onClosed={() => closeDeletion(deletion.n)}
        />
      )}
      {/* Present before anything is deleted: a live region speaks only when
          its text changes. Every other announcement ends in a no-break space. */}
      <p className="visually-hidden" role="status">{deleted.n % 2 ? `${deleted.text}\u00A0` : deleted.text}</p>
    </CustomFeedsContext.Provider>
  );
}
