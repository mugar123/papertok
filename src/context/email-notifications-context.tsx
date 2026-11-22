import type { PropsWithChildren } from 'react';
import type { NotificationPreferences } from '../services/email-notification-service.ts';
export interface EmailNotificationsContextValue {
  preferences: Required<NotificationPreferences>;
  loading: boolean; saving: boolean; testing: boolean; error: unknown;
  health: Awaited<ReturnType<typeof getEmailNotificationHealth>>;
  notificationDataReady: boolean; hasFollows: boolean;
  /** The digest can cover follows, chosen categories or citations through ORCID. */
  digestCovered: boolean;
  hasCitationSource: boolean;
  /** Turning the digest on or sending a test may send the follows in hand: a follow it lists, or the server's own answer that there is none. */
  digestSendReady: boolean;
  /** The app turned the digest off this session because there was nothing left for it to cover. */
  digestTurnedOff: boolean;
  /**
   * Whether the server holds an enabled digest for this account: `null` when
   * the preferences read failed, so Settings cannot tell an unsubscribed
   * reader from one it could not ask. False while the read is in flight.
   */
  digestSubscribed: boolean | null;
  reactivation: ReturnType<typeof useDigestReactivation>;
  /** A read of the stored preferences is under way (`refreshPreferences`). */
  refreshing: boolean;
  savePreferences: (preferences: NotificationPreferences) => Promise<Required<NotificationPreferences>>;
  sendTest: (preferences?: NotificationPreferences) => Promise<Awaited<ReturnType<typeof sendEmailNotificationTest>>>;
  /**
   * Reads the stored preferences again, since another tab or device may have
   * changed them. Rejects when the read fails, and keeps what is shown.
   * `background` is for a tab becoming visible: at most one read a minute.
   */
  refreshPreferences: (options?: { background?: boolean }) => Promise<void>;
  /** Hands the server a yes to the weekly email given on the welcome, once, for the account that has just been created. */
  startWelcomeDigest: (yes: { uid: string; interests: readonly string[] }) => void;
}

/* eslint-disable react-refresh/only-export-components -- the context module exports its provider together with its hook */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmailNotificationsContext } from './contexts.ts';
import { useAuth } from './auth-context.tsx';
import { useFollowing } from './following-context.tsx';
import { useFollowingUpdates } from './following-updates-context.tsx';
import { useLanguage } from './language-context.tsx';
import { useAnalyticsConsent } from './privacy-context.tsx';
import {
  EmailNotificationServiceError,
  getEmailNotificationPreferences,
  getEmailNotificationHealth,
  hasDigestFollows,
  saveEmailNotificationPreferences,
  sendEmailNotificationTest,
  startEmailDigestOptIn,
  type DigestOptInOutcome,
} from '../services/email-notification-service.ts';
import { actionStart, toastError, toastForAccount, toastStandingNotice, type ActionStart } from '../components/ui/toast.ts';
import { emailServiceState } from '../utils/email-health.ts';
import { DIGEST_CONSENT_FIRST_FOLLOW, DIGEST_CONSENT_FROM_SIGNUP } from '../utils/digest-consent.ts';
import { createRequestChain, deliverWelcomeYes, legacyFlagSettles, optInFailureReason } from '../utils/digest-opt-in.ts';
import { digestInterestsToSend, requestAccountCurrent, digestProfileInterests, digestShutoffDue, digestShutoffNoticeShown, digestSyncAllowed } from '../utils/digest-shutoff.ts';
import { getFollowingSignature } from '../utils/following-updates.ts';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../services/firebase.ts';
import { normalizeOrcidConnection } from '../services/orcid-connection-service.ts';
import { useDigestReactivation } from '../hooks/use-digest-reactivation.ts';

const DEFAULT_PREFERENCES: Required<NotificationPreferences> = {
  enabled: false,
  frequency: 'weekly',
  maxPapers: 5,
  language: 'en',
  email: '',
  lastSentAt: null,
  lastTestAt: null,
};

/** A tab that becomes visible reads the stored preferences again at most this often. */
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;

export function EmailNotificationsProvider({ children }: PropsWithChildren) {
  const { user, emailDigestPending, settleEmailDigestOptIn, userPreferences, orcid } = useAuth();
  const { language } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  // Read through a ref: `navigate` changes with every route, and the context
  // value, with the timers that depend on it, must not.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const userEmail = user?.email || '';
  const { followedEntities, loading: followsLoading, error: followsError, confirmed: followsConfirmed } = useFollowing();
  const { items, loading: updatesLoading } = useFollowingUpdates();
  const [preferences, setPreferences] = useState<Required<NotificationPreferences>>({ ...DEFAULT_PREFERENCES, language, email: userEmail });
  const [loading, setLoading] = useState(Boolean(user));
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [digestTurnedOffFor, setDigestTurnedOffFor] = useState<string | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof getEmailNotificationHealth>>>({
    configured: false,
    available: false,
    provider: null,
    code: null,
    senderMode: null,
    permissionLimited: false,
  });
  const loadedForUser = useRef<string | null>(null);
  const userId = user?.uid || null;
  // The account the app shows now, for what answers after an await: a request
  // sent for one account must not touch the state or the analytics of the next.
  const currentUserId = useRef<string | null>(userId);
  useEffect(() => {
    currentUserId.current = userId;
  }, [userId]);
  // The provider unmounts on every account change (app.tsx keys it by
  // account): from then on nothing more is sent or shown, and the waits between
  // attempts end at once.
  const mounted = useRef(true);
  const [waits] = useState(() => new Set<() => void>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      waits.forEach(wake => wake());
    };
  }, [waits]);
  const waitWhileMounted = useCallback((milliseconds: number) => new Promise<void>((resolve) => {
    const wait: { timeout?: ReturnType<typeof setTimeout> } = {};
    const wake = () => {
      clearTimeout(wait.timeout);
      waits.delete(wake);
      resolve();
    };
    wait.timeout = setTimeout(wake, milliseconds);
    waits.add(wake);
  }), [waits]);
  // The account whose preferences came from the server, by a read or a save.
  const [preferencesFrom, setPreferencesFrom] = useState<string | null>(null);
  const digestSubscribed = preferencesFrom === userId ? preferences.enabled : loading ? false : null;
  const reactivation = useDigestReactivation(userId, digestSubscribed, user?.emailVerified === true);
  const followSignature = useMemo(() => getFollowingSignature(followedEntities), [followedEntities]);
  const previewSignature = useMemo(() => items.slice(0, 20).map(item => item.updateKey || item.id || item.doi).join('|'), [items]);
  const notificationDataReady = !followsLoading && !followsError;
  // Journals do not count: a reader who follows only journals is told that
  // journals are not in the email (emailFollowsNotice), and no save, sync or
  // opt-in sends an empty follow list.
  const hasFollows = hasDigestFollows(followedEntities);
  // The reader's chosen categories fill the digest while nothing it covers is
  // followed (ENG-163). Only their leaf ids reach the Worker.
  // The profile is read once per session by AuthContext, so a tab left open
  // would send categories changed since on another device, or shut the digest
  // off on a list emptied there. The digest listens to the profile itself, like
  // the follows, and trusts only the server's copy.
  const [liveProfile, setLiveProfile] = useState<{ uid: string; interests: string[]; hasCitationSource: boolean; confirmed: boolean } | null>(null);
  useEffect(() => {
    if (!userId) return undefined;
    return onSnapshot(doc(db, 'users', userId), { includeMetadataChanges: true }, (snapshot) => {
      const data = snapshot.data();
      const connection = normalizeOrcidConnection(data?.orcid);
      const hasCitationSource = connection?.host === 'orcid.org' && Boolean(connection.connectedAt);
      // A snapshot that still holds a write the server has not acknowledged is
      // not the server's copy either: topics changed a moment ago could be sent
      // before they are saved.
      const next = { ...digestProfileInterests(data, snapshot.metadata), hasCitationSource };
      // The same answer keeps the same object, so a metadata-only snapshot
      // does not schedule another digest sync.
      setLiveProfile(current => (
        current?.uid === userId && current.confirmed === next.confirmed && current.interests.join() === next.interests.join() && current.hasCitationSource === next.hasCitationSource
          ? current
          : { uid: userId, ...next }
      ));
    }, (listenError) => {
      console.warn('Could not follow the profile for the email digest', listenError);
      setLiveProfile(current => (current?.uid === userId ? { ...current, confirmed: false } : null));
    });
  }, [userId]);
  const profileForUser = liveProfile?.uid === userId ? liveProfile : null;
  // Until the listener answers, the categories in hand only decide what the
  // settings screen shows; nothing unconfirmed is sent.
  const fallbackInterests = useMemo(() => digestProfileInterests({ preferences: userPreferences }, { fromCache: true, hasPendingWrites: false }).interests, [userPreferences]);
  const interests = profileForUser ? profileForUser.interests : fallbackInterests;
  const hasCitationSource = profileForUser?.hasCitationSource ?? (orcid?.host === 'orcid.org' && Boolean(orcid.connectedAt));
  const digestCovered = hasFollows || interests.length > 0 || hasCitationSource;
  const interestsConfirmed = profileForUser?.confirmed ?? false;
  const sentInterests = digestInterestsToSend({ interests, interestsConfirmed });
  // An empty follow list read from the cache must not replace the follows the
  // Worker stores, whether a sync, a save that turns the digest on or a test
  // sends it. Turning the digest off sends no follows to keep, so it stays open.
  const digestSendReady = digestSyncAllowed({ hasFollows, followsConfirmed, interestsConfirmed });

  // The same reset `FollowingContext` does, and for the same reason: the tree
  // above is no longer rebuilt when the session resolves
  // (utils/account-scope.ts), so `useState(Boolean(user))` no longer catches the
  // account arriving and a cold load would render these preferences as
  // loaded-and-empty. Keyed on the account alone, so the effect below re-running
  // on `language` or `userEmail` cannot re-close the gate and flicker the
  // settings screen.
  const [loadingAccount, setLoadingAccount] = useState(userId);
  if (loadingAccount !== userId) {
    setLoadingAccount(userId);
    setLoading(Boolean(userId));
  }

  // Every write to the digest subscription from this tab goes through one
  // chain, one request at a time: a welcome yes on its way, a save, a test, the
  // sync and the shut-off reach the server, and are answered here, in the order
  // they were made. So an Off pressed while a welcome yes is in flight is sent
  // after it and its answer is the last one shown. Reads stay outside the
  // chain and are shown only when no write overlapped them (utils/digest-opt-in.ts).
  // A save, a test and the notice's Turn off are never skipped on the strength
  // of an earlier answer: a write whose answer was lost may have taken effect,
  // so the reader's own decision always reaches the server. (The background
  // sync and the shut-off still run only while this tab shows the email on.)
  // Reminder consent and visits are not subscription writes and keep their own
  // requests (hooks/use-digest-reactivation.ts).
  const [chain] = useState(createRequestChain);
  // What the last server answer made of the preferences. Set as the answer is
  // applied, not at the next render, because the next request in the chain may
  // start first: it reads here whether the email was on.
  const shown = useRef(preferences);

  const accountCurrent = useCallback((requestUid: string | null) => (
    mounted.current && requestAccountCurrent({ requestUid, shownUid: currentUserId.current, signedInUid: auth.currentUser?.uid })
  ), []);

  // What answers after an await belongs to the account that asked. Once the app
  // shows, or Firebase holds, another account, its state and its analytics are
  // not touched.
  const assertCurrentAccount: (requestUid: string | null) => asserts requestUid is string = useCallback((requestUid: string | null) => {
    if (!accountCurrent(requestUid)) throw new EmailNotificationServiceError('EMAIL_ACCOUNT_CHANGED', 401);
  }, [accountCurrent]);

  // Shows a server answer. An identical answer keeps the same object, so the
  // sync effect below does not run again for it.
  const showServerPreferences = useCallback((uid: string, answer: NotificationPreferences) => {
    const next = { ...DEFAULT_PREFERENCES, ...answer, language, email: answer.email || userEmail };
    const current = shown.current;
    const normalized = (Object.keys(next) as (keyof NotificationPreferences)[]).some(field => next[field] !== current[field]) ? next : current;
    shown.current = normalized;
    setPreferences(normalized);
    setPreferencesFrom(uid);
    return normalized;
  }, [language, userEmail]);

  // While the first read of an account is in flight, another read adds nothing.
  const initialLoadPending = useRef(false);
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    loadedForUser.current = userId;
    initialLoadPending.current = true;
    const start = chain.mark();
    void Promise.allSettled([getEmailNotificationPreferences(userId), getEmailNotificationHealth()])
      .then(([preferencesResult, healthResult]) => {
        if (cancelled) return;
        if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
        // A write queued since this read started has the newer answer.
        if (!chain.readApplies(start) || !accountCurrent(userId)) return;
        if (preferencesResult.status === 'fulfilled') {
          showServerPreferences(userId, preferencesResult.value);
        } else if ((preferencesResult.reason as { code?: string } | null)?.code !== 'EMAIL_ACCOUNT_CHANGED') {
          // Firebase moved to another account before this tab did; the next
          // account's own load follows, and must not inherit this failure.
          setError(preferencesResult.reason);
        }
      })
      .finally(() => {
        if (cancelled) return;
        initialLoadPending.current = false;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountCurrent, chain, showServerPreferences, userId]);

  const refreshes = useRef(0);
  const lastBackgroundRefresh = useRef(0);
  const refreshPreferences = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    const requestUid = userId;
    if (!requestUid || initialLoadPending.current) return;
    if (background) {
      if (Date.now() - lastBackgroundRefresh.current < BACKGROUND_REFRESH_INTERVAL_MS) return;
      lastBackgroundRefresh.current = Date.now();
    }
    refreshes.current += 1;
    setRefreshing(true);
    try {
      // After the writes already queued, so the read describes what they left.
      await chain.idle();
      const start = chain.mark();
      const stored = await getEmailNotificationPreferences(requestUid);
      if (!chain.readApplies(start) || !accountCurrent(requestUid)) return;
      showServerPreferences(requestUid, stored);
      setError(null);
    } finally {
      refreshes.current -= 1;
      if (refreshes.current === 0 && mounted.current) setRefreshing(false);
    }
  }, [accountCurrent, chain, showServerPreferences, userId]);

  /**
   * Both callbacks below write the subscription to the server, so both are a
   * place a subscription can begin — and the event that records it is a delta,
   * which only fires for whichever one the user reaches first. While only
   * `savePreferences` reported, anyone who enabled the toggle and pressed
   * «Enviar prueba» was subscribed for real and silently: by the time they
   * pressed «Guardar cambios» the delta was already spent, and
   * `newsletter_change` never arrived once in three months. Applying every
   * saved response through here keeps the two ends of that decision in one
   * place. `wasEnabled` is read as the answer is applied, inside the chain, so
   * a welcome yes answered just before a save cannot make that save report a
   * second subscribe.
   */
  const applySavedPreferences = useCallback((uid: string, saved: NotificationPreferences, wasEnabled = shown.current.enabled) => {
    const normalized = showServerPreferences(uid, saved);
    if (normalized.enabled !== wasEnabled) {
      void trackEvent('newsletter_change', {
        action: normalized.enabled ? 'subscribe' : 'unsubscribe',
      });
      if (normalized.enabled) void markActivation();
    }
    return normalized;
  }, [markActivation, showServerPreferences, trackEvent]);

  // Once the reader has decided about the email themselves, a yes from the
  // welcome that still waits in the profile is finished with. The save has
  // reached their object, so the server declines that yes from now on, and
  // the profile stops saying it waits for a first follow.
  const retirePendingYes = useCallback(() => {
    if (!emailDigestPending) return;
    settleEmailDigestOptIn()
      .catch(settleError => console.warn('Could not settle the email digest opt-in', settleError));
  }, [emailDigestPending, settleEmailDigestOptIn]);

  const savePreferences = useCallback(async (nextPreferences: NotificationPreferences) => {
    if (!notificationDataReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    if (nextPreferences.enabled && !digestCovered) {
      throw new EmailNotificationServiceError('EMAIL_FOLLOWS_REQUIRED', 409);
    }
    if (nextPreferences.enabled && !digestSendReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    const requestUid = userId;
    setSaving(true);
    setError(null);
    try {
      // Always sent, a save that keeps the email off included: it is the
      // reader's decision, and what the server holds is never assumed.
      const applied = await chain.run(async () => {
        const saved = await saveEmailNotificationPreferences(
          { ...nextPreferences, language },
          followedEntities,
          items,
          { interests: sentInterests, uid: requestUid ?? undefined },
        );
        assertCurrentAccount(requestUid);
        return applySavedPreferences(requestUid, saved);
      });
      retirePendingYes();
      return applied;
    } catch (saveError) {
      if (requestUid === currentUserId.current) setError(saveError);
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, [applySavedPreferences, assertCurrentAccount, chain, digestCovered, digestSendReady, followedEntities, items, language, notificationDataReady, retirePendingYes, sentInterests, userId]);

  const sendTest = useCallback(async (nextPreferences: NotificationPreferences = preferences) => {
    if (!notificationDataReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    if (!digestCovered) throw new EmailNotificationServiceError('EMAIL_FOLLOWS_REQUIRED', 409);
    if (!digestSendReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    const requestUid = userId;
    setTesting(true);
    setError(null);
    try {
      // One task: nothing else from this tab lands between the save and the send.
      return await chain.run(async () => {
        const saved = await saveEmailNotificationPreferences(
          { ...nextPreferences, enabled: true, language },
          followedEntities,
          items,
          { interests: sentInterests, uid: requestUid ?? undefined },
        );
        assertCurrentAccount(requestUid);
        const normalized = applySavedPreferences(requestUid, saved);
        const result = await sendEmailNotificationTest(requestUid);
        assertCurrentAccount(requestUid);
        return { ...result, preferences: result.preferences ? showServerPreferences(requestUid, { ...normalized, ...result.preferences }) : normalized };
      });
    } catch (testError) {
      if (requestUid === currentUserId.current) setError(testError);
      throw testError;
    } finally {
      setTesting(false);
    }
  }, [applySavedPreferences, assertCurrentAccount, chain, digestCovered, digestSendReady, followedEntities, items, language, notificationDataReady, preferences, sentInterests, showServerPreferences, userId]);

  // One attempt to hand a yes from the welcome to the server, as a task of the
  // chain: the request, and the answer shown. Only `created` is the start of a
  // subscription, so only it reports the event a subscribe from Settings
  // reports; `on` and `declined` say what the reader had already decided.
  const sendOptIn = useCallback((uid: string, yes: Parameters<typeof startEmailDigestOptIn>[0]) => chain.run(async () => {
    const answer = await startEmailDigestOptIn(yes, uid);
    assertCurrentAccount(uid);
    const applied = answer.outcome === 'created'
      ? applySavedPreferences(uid, answer.preferences, false)
      : showServerPreferences(uid, answer.preferences);
    return { outcome: answer.outcome, email: applied.email };
  }), [applySavedPreferences, assertCurrentAccount, chain, showServerPreferences]);

  // "Turn off" on the notice of an email a welcome yes started: the same
  // unsubscribe Settings sends, through the chain, so it follows the opt-in
  // that started the email and anything queued since.
  const turnOffFromNotice = useCallback((uid: string) => {
    const startedAt = actionStart();
    chain.run(async () => {
      const saved = await saveEmailNotificationPreferences({ ...shown.current, enabled: false, language }, [], [], { uid });
      assertCurrentAccount(uid);
      return applySavedPreferences(uid, saved);
    }).then(() => {
      toastForAccount(uid, 'Your weekly email is off', { description: 'You can turn it on again in Settings.' });
    }, (turnOffError) => {
      console.warn('Could not turn the weekly email off from its notice', turnOffError);
      if (!accountCurrent(uid)) return;
      toastError("Your weekly email couldn't be turned off", {
        startedAt,
        description: 'It may still be on. Check it in Settings.',
        action: { label: 'Open Settings', onClick: () => { void navigateRef.current('/settings/notifications'); } },
      });
    });
  }, [accountCurrent, applySavedPreferences, assertCurrentAccount, chain, language]);

  // What the reader is told once a yes from the welcome has an answer. A
  // `declined` says nothing: the reader turned the email off themselves.
  // The notice of a started email waits for the reader's answer, and carries
  // the way to stop it: on a shared device the person who creates the account
  // may not be the visitor who said yes, and was never asked. An overlay that
  // opens meanwhile, such as the privacy notice a new account can be owed, only
  // holds it back (toastStandingNotice).
  const reportOptIn = useCallback((uid: string, startedAt: ActionStart, result: { outcome: DigestOptInOutcome; email: string } | { failed: unknown }, covers: string) => {
    if ('failed' in result) {
      if (!accountCurrent(uid)) return;
      toastError("Your weekly email didn't start", {
        startedAt,
        description: optInFailureReason(result.failed, { accountHasEmail: Boolean(auth.currentUser?.email) }),
        action: { label: 'Open Settings', onClick: () => { void navigateRef.current('/settings/notifications'); } },
      });
    } else if (result.outcome !== 'declined') {
      toastStandingNotice(uid, 'Your weekly email is on', {
        description: `It goes to ${result.email} on Mondays, when there are new papers ${covers}. You can also turn it off in Settings.`,
        action: { label: 'Turn off', onClick: () => { turnOffFromNotice(uid); } },
      });
    }
  }, [accountCurrent, turnOffFromNotice]);

  // A yes given on the welcome under the text that promises the email from
  // sign-up. Onboarding hands it over once the account's profile is written
  // (completeOnboarding), and it is sent to the server from here, where it
  // outlives the onboarding screen. The server starts the subscription only
  // for an account that never decided about the email. Nothing is stored in
  // the browser: a tab closed before an answer loses the yes, and the reader
  // can turn the email on in Settings.
  const welcomeStarted = useRef(false);
  const startWelcomeDigest = useCallback(({ uid, interests: chosen }: { uid: string; interests: readonly string[] }) => {
    if (welcomeStarted.current) return;
    welcomeStarted.current = true;
    const startedAt = actionStart();
    void deliverWelcomeYes({
      send: () => sendOptIn(uid, { consent: DIGEST_CONSENT_FROM_SIGNUP, interests: chosen }),
      current: () => accountCurrent(uid),
      wait: waitWhileMounted,
    }).then((result) => {
      if (!result) return;
      reportOptIn(uid, startedAt, 'answer' in result ? result.answer : result, 'in your topics');
    });
  }, [accountCurrent, reportOptIn, sendOptIn, waitWhileMounted]);

  // A yes given under the earlier welcome text ("Starts with your first
  // follow") waits in the profile (`emailDigestPending`) and keeps that
  // promise: at the first follow other than a journal it goes to the server
  // through the same gated request, so a decision the reader made since, on
  // any device, declines it. Once per session. The flag is deleted on any
  // answer and on a refusal no retry changes (legacyFlagSettles); anything
  // else keeps it for the next session.
  const legacyAttemptedFor = useRef<string | null>(null);
  const emailServiceDown = emailServiceState(health) === 'down';
  useEffect(() => {
    if (
      !emailDigestPending
      || !userId
      || loading
      || error
      || preferencesFrom !== userId
      || legacyAttemptedFor.current === userId
      || !notificationDataReady
      || updatesLoading
    ) return undefined;
    const settle = () => {
      settleEmailDigestOptIn()
        .catch(settleError => console.warn('Could not settle the email digest opt-in', settleError));
    };
    if (preferences.enabled) {
      legacyAttemptedFor.current = userId;
      settle();
      return undefined;
    }
    if (!hasFollows || emailServiceDown) return undefined;
    // A beat after the follow lands, like the digest sync below, so a burst
    // of follows becomes one subscription carrying all of them.
    const optInTimeout = setTimeout(() => {
      legacyAttemptedFor.current = userId;
      const startedAt = actionStart();
      const accountHasEmail = Boolean(auth.currentUser?.email);
      sendOptIn(userId, { consent: DIGEST_CONSENT_FIRST_FOLLOW, follows: followedEntities, previewItems: items, interests: sentInterests ?? [] })
        .then((answer) => {
          settle();
          // An email that was already on is no news to the reader.
          if (answer.outcome === 'created') reportOptIn(userId, startedAt, answer, 'from what you follow');
        }, (optInError) => {
          console.warn('Could not start the email digest the reader opted into', optInError);
          if (!legacyFlagSettles({ error: optInError }, { accountHasEmail })) return;
          settle();
          const status = (optInError as { status?: number } | null)?.status;
          if (status === 401 || status === 403) reportOptIn(userId, startedAt, { failed: optInError }, '');
        });
    }, 1200);
    return () => clearTimeout(optInTimeout);
  }, [emailDigestPending, emailServiceDown, error, followedEntities, hasFollows, items, loading, notificationDataReady, preferences.enabled, preferencesFrom, reportOptIn, sendOptIn, sentInterests, settleEmailDigestOptIn, updatesLoading, userId]);

  useEffect(() => {
    if (
      !preferences.enabled
      || !userId
      || followsLoading
      || followsError
      || updatesLoading
      || !digestCovered
      || !digestSendReady
      || loadedForUser.current !== userId
    ) return undefined;
    let cancelled = false;
    const syncTimeout = setTimeout(() => {
      // These preferences may predate an unsubscribe or a change made on
      // another device. The Worker answers a sync with the stored
      // subscription, so a reader who turned the digest off sees Off here and
      // this effect stops syncing. The answer skips applySavedPreferences:
      // the reader made no choice in this tab, so there is no
      // newsletter_change to report.
      chain.run(async () => {
        // Cancelled while it waited its turn: what it would send is out of date.
        if (cancelled) return;
        const saved = await saveEmailNotificationPreferences({ ...preferences, language }, followedEntities, items, { sync: true, interests: sentInterests, uid: userId });
        if (cancelled || !accountCurrent(userId)) return;
        showServerPreferences(userId, saved);
      }).catch(syncError => console.warn('Could not synchronize the notification digest', syncError));
    }, 1800);
    return () => {
      cancelled = true;
      clearTimeout(syncTimeout);
    };
  }, [accountCurrent, chain, digestCovered, digestSendReady, followSignature, followedEntities, followsError, followsLoading, items, language, preferences, previewSignature, sentInterests, showServerPreferences, updatesLoading, userId]);

  // Nothing left for the digest to cover with the digest on: no follow it
  // lists, no chosen category and no production ORCID connection. The Worker refuses an empty subscription and
  // the sync above stops, so the stored one would keep emailing what was last
  // synced (ENG-163). Turn it off through the same save the toggle uses, once,
  // and only when the follows and the profile are the server's own answer.
  const shutoffAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (digestCovered) {
      shutoffAttemptedFor.current = null;
      return;
    }
    if (!userId || loading || loadedForUser.current !== userId) return;
    if (!digestShutoffDue({
      enabled: preferences.enabled,
      followsConfirmed,
      interestsConfirmed,
      digestCovered,
      attempted: shutoffAttemptedFor.current === userId,
    })) return;
    shutoffAttemptedFor.current = userId;
    chain.run(async () => {
      const saved = await saveEmailNotificationPreferences({ ...preferences, enabled: false, language }, followedEntities, items, { uid: userId });
      if (!accountCurrent(userId)) return;
      // Like the sync, this skips applySavedPreferences: the reader did not
      // unsubscribe, so there is no newsletter_change to report.
      showServerPreferences(userId, saved);
      setDigestTurnedOffFor(userId);
    }).catch(shutoffError => console.warn('Could not turn the digest off with nothing left for it to cover', shutoffError));
  }, [accountCurrent, chain, digestCovered, followedEntities, followsConfirmed, interestsConfirmed, items, language, loading, preferences, showServerPreferences, userId]);

  const localizedPreferences = useMemo(
    () => ({ ...preferences, language }),
    [language, preferences],
  );

  const value = useMemo(() => ({
    preferences: localizedPreferences,
    loading,
    refreshing,
    saving,
    testing,
    error,
    health,
    notificationDataReady,
    hasFollows,
    hasCitationSource,
    digestCovered,
    digestSendReady,
    digestSubscribed,
    reactivation,
    digestTurnedOff: digestShutoffNoticeShown({
      turnedOffFor: digestTurnedOffFor,
      userId,
      enabled: localizedPreferences.enabled,
      digestCovered,
    }),
    savePreferences,
    sendTest,
    refreshPreferences,
    startWelcomeDigest,
  }), [digestCovered, digestSendReady, digestSubscribed, digestTurnedOffFor, error, hasCitationSource, hasFollows, health, loading, localizedPreferences, notificationDataReady, reactivation, refreshPreferences, refreshing, savePreferences, saving, sendTest, startWelcomeDigest, testing, userId]);

  return <EmailNotificationsContext.Provider value={value}>{children}</EmailNotificationsContext.Provider>;
}

export function useEmailNotifications() {
  const context = useContext(EmailNotificationsContext);
  if (!context) throw new Error('useEmailNotifications must be used within an EmailNotificationsProvider');
  return context;
}
