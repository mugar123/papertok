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
  /** A yes from the welcome still waits for the reader's first follow: given under the earlier welcome text, or with nothing yet to cover the digest. */
  digestWaitsForFollow: boolean;
  savePreferences: (preferences: NotificationPreferences) => Promise<Required<NotificationPreferences>>;
  sendTest: (preferences?: NotificationPreferences) => Promise<Awaited<ReturnType<typeof sendEmailNotificationTest>>>;
}

/* eslint-disable react-refresh/only-export-components -- the context module exports its provider together with its hook */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
} from '../services/email-notification-service.ts';
import { emailServiceState } from '../utils/email-health.ts';
import { DIGEST_CONSENT_SPENT, readDigestConsent, withDigestOptInLock, writeDigestConsent } from '../utils/digest-consent.ts';
import { digestInterestsToSend, digestOptInStep, digestOptInWaitsForFollow, digestProfileInterests, digestShutoffDue, digestShutoffNoticeShown, digestSyncAllowed } from '../utils/digest-shutoff.ts';
import { getFollowingSignature } from '../utils/following-updates.ts';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../services/firebase.ts';
import { normalizeOrcidConnection } from '../services/orcid-connection-service.ts';

const DEFAULT_PREFERENCES: Required<NotificationPreferences> = {
  enabled: false,
  frequency: 'weekly',
  maxPapers: 5,
  language: 'en',
  email: '',
  lastSentAt: null,
  lastTestAt: null,
};

export function EmailNotificationsProvider({ children }: PropsWithChildren) {
  const { user, emailDigestPending, settleEmailDigestOptIn, userPreferences, orcid } = useAuth();
  const { language } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const userEmail = user?.email || '';
  const { followedEntities, loading: followsLoading, error: followsError, confirmed: followsConfirmed } = useFollowing();
  const { items, loading: updatesLoading } = useFollowingUpdates();
  const [preferences, setPreferences] = useState<Required<NotificationPreferences>>({ ...DEFAULT_PREFERENCES, language, email: userEmail });
  const [loading, setLoading] = useState(Boolean(user));
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
  const [liveProfile, setLiveProfile] = useState<{ uid: string; interests: string[]; hasCitationSource: boolean; optIn: boolean; confirmed: boolean } | null>(null);
  useEffect(() => {
    if (!userId) return undefined;
    return onSnapshot(doc(db, 'users', userId), { includeMetadataChanges: true }, (snapshot) => {
      const data = snapshot.data();
      const connection = normalizeOrcidConnection(data?.orcid);
      const hasCitationSource = connection?.host === 'orcid.org' && Boolean(connection.connectedAt);
      // A snapshot that still holds a write the server has not acknowledged is
      // not the server's copy either: topics changed a moment ago could be sent
      // before they are saved.
      // The pending-yes flag, live: a tab left open must not act on a yes that
      // another tab or device has already settled.
      const next = { ...digestProfileInterests(data, snapshot.metadata), hasCitationSource, optIn: data?.emailDigestOptIn === true };
      // The same answer keeps the same object, so a metadata-only snapshot
      // does not schedule another digest sync.
      setLiveProfile(current => (
        current?.uid === userId && current.confirmed === next.confirmed && current.interests.join() === next.interests.join()
          && current.hasCitationSource === next.hasCitationSource && current.optIn === next.optIn
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
  const flagLive = profileForUser?.confirmed ? profileForUser.optIn : null;
  const optInFlagLive = useRef<boolean | null>(null);
  useEffect(() => {
    optInFlagLive.current = flagLive;
  }, [flagLive]);
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

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    loadedForUser.current = userId;
    void Promise.allSettled([getEmailNotificationPreferences(userId), getEmailNotificationHealth()])
      .then(([preferencesResult, healthResult]) => {
        if (cancelled) return;
        if (preferencesResult.status === 'fulfilled') {
          const next = preferencesResult.value;
          setPreferences({ ...DEFAULT_PREFERENCES, ...next, language, email: next.email || userEmail });
        } else if ((preferencesResult.reason as { code?: string } | null)?.code !== 'EMAIL_ACCOUNT_CHANGED') {
          // Firebase moved to another account before this tab did; the next
          // account's own load follows, and must not inherit this failure.
          setError(preferencesResult.reason);
        }
        if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [language, userEmail, userId]);

  /**
   * Both callbacks below write the subscription to the server, so both are a
   * place a subscription can begin — and the event that records it is a delta,
   * which only fires for whichever one the user reaches first. While only
   * `savePreferences` reported, anyone who enabled the toggle and pressed
   * «Enviar prueba» was subscribed for real and silently: by the time they
   * pressed «Guardar cambios» the delta was already spent, and
   * `newsletter_change` never arrived once in three months. Applying every
   * saved response through here keeps the two ends of that decision in one
   * place.
   */
  const applySavedPreferences = useCallback((saved: NotificationPreferences, wasEnabled: boolean) => {
    const normalized = { ...DEFAULT_PREFERENCES, ...saved, language, email: saved.email || userEmail };
    setPreferences(normalized);
    if (normalized.enabled !== wasEnabled) {
      void trackEvent('newsletter_change', {
        action: normalized.enabled ? 'subscribe' : 'unsubscribe',
      });
      if (normalized.enabled) void markActivation();
    }
    return normalized;
  }, [language, markActivation, trackEvent, userEmail]);

  // What answers after an await belongs to the account that asked. Once the app
  // shows another account, its state and its analytics are not touched.
  const assertCurrentAccount = useCallback((requestUid: string | null) => {
    if (requestUid !== currentUserId.current) throw new EmailNotificationServiceError('EMAIL_ACCOUNT_CHANGED', 401);
  }, []);

  // A pending yes from the welcome is decided by the reader's own choice to turn
  // the email on or off: a save from Settings that changes it, an unsubscribe
  // included, or a test email. Nothing may start the subscription afterwards, in
  // this session or a later one. It is held the moment the request starts, so an
  // activation already queued cannot overtake it, and spent once the server has
  // answered: the device records it before the flag is deleted, so if the delete
  // fails the next session deletes it again instead of acting on it. A save that
  // leaves the email as it was, a change to the paper count, decides nothing.
  const optInAttemptedFor = useRef<string | null>(null);
  const optInSpentFor = useRef<string | null>(null);
  const holdOptIn = useCallback((uid: string | null) => {
    if (!uid) return;
    optInSpentFor.current = uid;
    optInAttemptedFor.current = uid;
  }, []);
  const spendOptIn = useCallback((uid: string | null) => {
    if (!uid || !emailDigestPending) return;
    writeDigestConsent(uid, DIGEST_CONSENT_SPENT);
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
    const decidesEmail = Boolean(nextPreferences.enabled) !== preferences.enabled;
    if (decidesEmail) holdOptIn(requestUid);
    setSaving(true);
    setError(null);
    try {
      const wasEnabled = preferences.enabled;
      const saved = await saveEmailNotificationPreferences(
        { ...nextPreferences, language },
        followedEntities,
        items,
        { interests: sentInterests, uid: requestUid ?? undefined },
      );
      assertCurrentAccount(requestUid);
      if (decidesEmail) spendOptIn(requestUid);
      return applySavedPreferences(saved, wasEnabled);
    } catch (saveError) {
      if (requestUid === currentUserId.current) setError(saveError);
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, [applySavedPreferences, assertCurrentAccount, digestCovered, digestSendReady, followedEntities, items, language, notificationDataReady, sentInterests, preferences.enabled, holdOptIn, spendOptIn, userId]);

  const sendTest = useCallback(async (nextPreferences: NotificationPreferences = preferences) => {
    if (!notificationDataReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    if (!digestCovered) throw new EmailNotificationServiceError('EMAIL_FOLLOWS_REQUIRED', 409);
    if (!digestSendReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    const requestUid = userId;
    const decidesEmail = !preferences.enabled;
    if (decidesEmail) holdOptIn(requestUid);
    setTesting(true);
    setError(null);
    try {
      const wasEnabled = preferences.enabled;
      const saved = await saveEmailNotificationPreferences(
        { ...nextPreferences, enabled: true, language },
        followedEntities,
        items,
        { interests: sentInterests, uid: requestUid ?? undefined },
      );
      assertCurrentAccount(requestUid);
      if (decidesEmail) spendOptIn(requestUid);
      const normalized = applySavedPreferences(saved, wasEnabled);
      const result = await sendEmailNotificationTest(requestUid ?? undefined);
      assertCurrentAccount(requestUid);
      if (result.preferences) {
        setPreferences(current => ({ ...current, ...result.preferences }));
      }
      return { ...result, preferences: result.preferences || normalized };
    } catch (testError) {
      if (requestUid === currentUserId.current) setError(testError);
      throw testError;
    } finally {
      setTesting(false);
    }
  }, [applySavedPreferences, assertCurrentAccount, digestCovered, digestSendReady, followedEntities, items, language, notificationDataReady, sentInterests, preferences, holdOptIn, spendOptIn, userId]);

  // A yes from the guest welcome, carried out here, to the address the account
  // signs in with. A yes given under the welcome text that promised the email
  // from sign-up starts on the chosen topics alone; any other keeps the
  // promise it was given under, the first follow other than a journal
  // (digestOptInStep). The request is bound to the account that said yes, under
  // a lock shared by this browser's tabs, and reads the stored subscription
  // first, so a tab, another device or the reader's own choice that came
  // earlier is respected. Once per session; a failure keeps the flag and the
  // next session tries again. Once the subscription exists the flag is spent,
  // so a later unsubscribe, in Settings or from the email, is never undone.
  const emailServiceDown = emailServiceState(health) === 'down';
  // Read on every render, not memoised: onboarding and a settle write the device
  // record, and the next render must see it.
  const digestConsent = readDigestConsent(userId);
  const digestWaitsForFollow = digestOptInWaitsForFollow({ pending: emailDigestPending, consent: digestConsent, covered: digestCovered });
  const startOptIn = useCallback(async (uid: string) => {
    // Read again after each await: another tab's settle can arrive meanwhile.
    const flagGone = () => optInFlagLive.current === false;
    const outcome = await withDigestOptInLock(uid, async () => {
      if (optInSpentFor.current === uid || flagGone()) return 'spent' as const;
      const stored = await getEmailNotificationPreferences(uid);
      assertCurrentAccount(uid);
      // The device record is shared by this browser's tabs: another tab may have
      // spent the yes since this one memoised it.
      if (optInSpentFor.current === uid || flagGone() || readDigestConsent(uid) === DIGEST_CONSENT_SPENT) return 'spent' as const;
      if (stored.enabled) {
        setPreferences({ ...DEFAULT_PREFERENCES, ...stored, language, email: stored.email || userEmail });
        return 'on' as const;
      }
      const saved = await saveEmailNotificationPreferences(
        { ...DEFAULT_PREFERENCES, ...stored, enabled: true, language, email: stored.email || userEmail },
        followedEntities,
        items,
        { interests: sentInterests, uid },
      );
      assertCurrentAccount(uid);
      // The same event a subscribe from Settings reports.
      applySavedPreferences(saved, false);
      return 'on' as const;
    });
    if (outcome !== 'on') return;
    writeDigestConsent(uid, DIGEST_CONSENT_SPENT);
    await settleEmailDigestOptIn();
  }, [applySavedPreferences, assertCurrentAccount, followedEntities, items, language, sentInterests, settleEmailDigestOptIn, userEmail]);
  useEffect(() => {
    if (
      !emailDigestPending
      || !userId
      || loading
      || error
      || loadedForUser.current !== userId
      || !notificationDataReady
      || updatesLoading
    ) return undefined;
    const step = digestOptInStep({
      consent: digestConsent,
      attempted: optInAttemptedFor.current === userId,
      flagLive,
      enabled: preferences.enabled,
      serviceDown: emailServiceDown,
      hasFollows,
      digestCovered,
      digestSendReady,
    });
    if (step === 'settle') {
      optInAttemptedFor.current = userId;
      settleEmailDigestOptIn()
        .catch(settleError => console.warn('Could not settle the email digest opt-in', settleError));
      return undefined;
    }
    if (step === 'wait') return undefined;
    // A beat after the follow lands, like the digest sync below, so a burst
    // of follows becomes one subscription carrying all of them.
    const optInTimeout = setTimeout(() => {
      optInAttemptedFor.current = userId;
      startOptIn(userId)
        .catch(optInError => console.warn('Could not start the email digest the reader opted into', optInError));
    }, 1200);
    return () => clearTimeout(optInTimeout);
  }, [digestConsent, digestCovered, digestSendReady, emailDigestPending, emailServiceDown, error, flagLive, hasFollows, loading, notificationDataReady, preferences.enabled, settleEmailDigestOptIn, startOptIn, updatesLoading, userId]);

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
      saveEmailNotificationPreferences({ ...preferences, language }, followedEntities, items, { sync: true, interests: sentInterests, uid: userId })
        .then(saved => {
          if (cancelled || currentUserId.current !== userId) return;
          setPreferences(current => {
            const next = { ...DEFAULT_PREFERENCES, ...saved, language, email: saved.email || userEmail };
            // An identical answer keeps the same object; a new one would
            // rerun this effect and sync again.
            return (Object.keys(next) as (keyof NotificationPreferences)[]).some(field => next[field] !== current[field]) ? next : current;
          });
        })
        .catch(syncError => console.warn('Could not synchronize the notification digest', syncError));
    }, 1800);
    return () => {
      cancelled = true;
      clearTimeout(syncTimeout);
    };
  }, [digestCovered, digestSendReady, followSignature, followedEntities, followsError, followsLoading, items, language, preferences, previewSignature, sentInterests, updatesLoading, userEmail, userId]);

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
    saveEmailNotificationPreferences({ ...preferences, enabled: false, language }, followedEntities, items, { uid: userId })
      .then(saved => {
        if (currentUserId.current !== userId) return;
        // Like the sync, this skips applySavedPreferences: the reader did not
        // unsubscribe, so there is no newsletter_change to report.
        setPreferences({ ...DEFAULT_PREFERENCES, ...saved, language, email: saved.email || userEmail });
        setDigestTurnedOffFor(userId);
      })
      .catch(shutoffError => console.warn('Could not turn the digest off with nothing left for it to cover', shutoffError));
  }, [digestCovered, followedEntities, followsConfirmed, interestsConfirmed, items, language, loading, preferences, userEmail, userId]);

  const localizedPreferences = useMemo(
    () => ({ ...preferences, language }),
    [language, preferences],
  );

  const value = useMemo(() => ({
    preferences: localizedPreferences,
    loading,
    saving,
    testing,
    error,
    health,
    notificationDataReady,
    hasFollows,
    hasCitationSource,
    digestCovered,
    digestSendReady,
    digestTurnedOff: digestShutoffNoticeShown({
      turnedOffFor: digestTurnedOffFor,
      userId,
      enabled: localizedPreferences.enabled,
      digestCovered,
    }),
    digestWaitsForFollow,
    savePreferences,
    sendTest,
  }), [digestCovered, digestSendReady, digestTurnedOffFor, digestWaitsForFollow, error, hasCitationSource, hasFollows, health, loading, localizedPreferences, notificationDataReady, savePreferences, saving, sendTest, testing, userId]);

  return <EmailNotificationsContext.Provider value={value}>{children}</EmailNotificationsContext.Provider>;
}

export function useEmailNotifications() {
  const context = useContext(EmailNotificationsContext);
  if (!context) throw new Error('useEmailNotifications must be used within an EmailNotificationsProvider');
  return context;
}
