import type { PropsWithChildren } from 'react';
import type { NotificationPreferences } from '../services/email-notification-service.ts';
export interface EmailNotificationsContextValue {
  preferences: Required<NotificationPreferences>;
  loading: boolean; saving: boolean; testing: boolean; error: unknown;
  health: Awaited<ReturnType<typeof getEmailNotificationHealth>>;
  notificationDataReady: boolean; hasFollows: boolean;
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
import { useAnalyticsConsent } from './analytics-context.tsx';
import {
  EmailNotificationServiceError,
  getEmailNotificationPreferences,
  getEmailNotificationHealth,
  hasDigestFollows,
  saveEmailNotificationPreferences,
  sendEmailNotificationTest,
} from '../services/email-notification-service.ts';
import { emailServiceState } from '../utils/email-health.ts';
import { getFollowingSignature } from '../utils/following-updates.ts';

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
  const { user, emailDigestPending, settleEmailDigestOptIn } = useAuth();
  const { language } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const userEmail = user?.email || '';
  const { followedEntities, loading: followsLoading, error: followsError } = useFollowing();
  const { items, loading: updatesLoading } = useFollowingUpdates();
  const [preferences, setPreferences] = useState<Required<NotificationPreferences>>({ ...DEFAULT_PREFERENCES, language, email: userEmail });
  const [loading, setLoading] = useState(Boolean(user));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
  const followSignature = useMemo(() => getFollowingSignature(followedEntities), [followedEntities]);
  const previewSignature = useMemo(() => items.slice(0, 20).map(item => item.updateKey || item.id || item.doi).join('|'), [items]);
  const notificationDataReady = !followsLoading && !followsError;
  // Journals do not count: a reader who follows only journals sees "Nothing
  // followed yet", and no save, sync or opt-in sends an empty follow list.
  const hasFollows = hasDigestFollows(followedEntities);

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
    void Promise.allSettled([getEmailNotificationPreferences(), getEmailNotificationHealth()])
      .then(([preferencesResult, healthResult]) => {
        if (cancelled) return;
        if (preferencesResult.status === 'fulfilled') {
          const next = preferencesResult.value;
          setPreferences({ ...DEFAULT_PREFERENCES, ...next, language, email: next.email || userEmail });
        } else {
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

  const savePreferences = useCallback(async (nextPreferences: NotificationPreferences) => {
    if (!notificationDataReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    if (nextPreferences.enabled && !hasFollows) {
      throw new EmailNotificationServiceError('EMAIL_FOLLOWS_REQUIRED', 409);
    }
    setSaving(true);
    setError(null);
    try {
      const wasEnabled = preferences.enabled;
      const saved = await saveEmailNotificationPreferences(
        { ...nextPreferences, language },
        followedEntities,
        items,
      );
      return applySavedPreferences(saved, wasEnabled);
    } catch (saveError) {
      setError(saveError);
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, [applySavedPreferences, followedEntities, hasFollows, items, language, notificationDataReady, preferences.enabled]);

  const sendTest = useCallback(async (nextPreferences: NotificationPreferences = preferences) => {
    if (!notificationDataReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    if (!hasFollows) throw new EmailNotificationServiceError('EMAIL_FOLLOWS_REQUIRED', 409);
    setTesting(true);
    setError(null);
    try {
      const wasEnabled = preferences.enabled;
      const saved = await saveEmailNotificationPreferences(
        { ...nextPreferences, enabled: true, language },
        followedEntities,
        items,
      );
      const normalized = applySavedPreferences(saved, wasEnabled);
      const result = await sendEmailNotificationTest();
      if (result.preferences) {
        setPreferences(current => ({ ...current, ...result.preferences }));
      }
      return { ...result, preferences: result.preferences || normalized };
    } catch (testError) {
      setError(testError);
      throw testError;
    } finally {
      setTesting(false);
    }
  }, [applySavedPreferences, followedEntities, hasFollows, items, language, notificationDataReady, preferences]);

  // A yes from the guest welcome, carried out here: the account is created
  // with no follows and the digest is built from them (the Worker refuses an
  // empty subscription), so the subscription starts with the first follow
  // other than a journal, to the address the account signs in with. Once per
  // session; a failure keeps the flag and the next session tries again. Once
  // it exists — or the reader already turned email on themselves — the flag is
  // spent, so a later unsubscribe in Settings is never undone.
  const optInAttemptedFor = useRef<string | null>(null);
  const emailServiceDown = emailServiceState(health) === 'down';
  useEffect(() => {
    if (
      !emailDigestPending
      || !userId
      || loading
      || error
      || loadedForUser.current !== userId
      || optInAttemptedFor.current === userId
      || !notificationDataReady
      || updatesLoading
    ) return undefined;
    if (preferences.enabled) {
      optInAttemptedFor.current = userId;
      settleEmailDigestOptIn()
        .catch(settleError => console.warn('Could not settle the email digest opt-in', settleError));
      return undefined;
    }
    if (!hasFollows || emailServiceDown) return undefined;
    // A beat after the follow lands, like the digest sync below, so a burst
    // of follows becomes one subscription carrying all of them.
    const optInTimeout = setTimeout(() => {
      optInAttemptedFor.current = userId;
      savePreferences({ ...preferences, enabled: true })
        .then(() => settleEmailDigestOptIn())
        .catch(optInError => console.warn('Could not start the email digest the reader opted into', optInError));
    }, 1200);
    return () => clearTimeout(optInTimeout);
  }, [emailDigestPending, emailServiceDown, error, hasFollows, loading, notificationDataReady, preferences, savePreferences, settleEmailDigestOptIn, updatesLoading, userId]);

  useEffect(() => {
    if (
      !preferences.enabled
      || !userId
      || followsLoading
      || followsError
      || updatesLoading
      || !hasFollows
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
      saveEmailNotificationPreferences({ ...preferences, language }, followedEntities, items, { sync: true })
        .then(saved => {
          if (cancelled) return;
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
  }, [followSignature, followedEntities, followsError, followsLoading, hasFollows, items, language, preferences, previewSignature, updatesLoading, userEmail, userId]);

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
    savePreferences,
    sendTest,
  }), [error, hasFollows, health, loading, localizedPreferences, notificationDataReady, savePreferences, saving, sendTest, testing]);

  return <EmailNotificationsContext.Provider value={value}>{children}</EmailNotificationsContext.Provider>;
}

export function useEmailNotifications() {
  const context = useContext(EmailNotificationsContext);
  if (!context) throw new Error('useEmailNotifications must be used within an EmailNotificationsProvider');
  return context;
}
