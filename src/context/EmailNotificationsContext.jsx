/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { EmailNotificationsContext } from './contexts';
import { useAuth } from './AuthContext';
import { useFollowing } from './FollowingContext';
import { useFollowingUpdates } from './FollowingUpdatesContext';
import { useLanguage } from './LanguageContext';
import { useAnalyticsConsent } from './AnalyticsContext';
import {
  EmailNotificationServiceError,
  getEmailNotificationPreferences,
  getEmailNotificationHealth,
  saveEmailNotificationPreferences,
  sendEmailNotificationTest,
} from '../services/emailNotificationService';
import { getFollowingSignature } from '../utils/followingUpdates';

const DEFAULT_PREFERENCES = {
  enabled: false,
  frequency: 'daily',
  maxPapers: 5,
  language: 'en',
  email: '',
  lastSentAt: null,
  lastTestAt: null,
};

export function EmailNotificationsProvider({ children }) {
  const { user } = useAuth();
  const { language } = useLanguage();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const userEmail = user?.email || '';
  const { followedEntities, loading: followsLoading, error: followsError } = useFollowing();
  const { items, loading: updatesLoading } = useFollowingUpdates();
  const [preferences, setPreferences] = useState({ ...DEFAULT_PREFERENCES, language, email: userEmail });
  const [loading, setLoading] = useState(Boolean(user));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [health, setHealth] = useState({
    configured: false,
    available: false,
    provider: null,
    code: null,
    senderMode: null,
    permissionLimited: false,
  });
  const loadedForUser = useRef(null);
  const userId = user?.uid || null;
  const followSignature = useMemo(() => getFollowingSignature(followedEntities), [followedEntities]);
  const previewSignature = useMemo(() => items.slice(0, 20).map(item => item.updateKey || item.id || item.doi).join('|'), [items]);
  const notificationDataReady = !followsLoading && !followsError;
  const hasFollows = followedEntities.length > 0;

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    loadedForUser.current = userId;
    Promise.allSettled([getEmailNotificationPreferences(), getEmailNotificationHealth()])
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

  const savePreferences = useCallback(async (nextPreferences) => {
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
      const normalized = { ...DEFAULT_PREFERENCES, ...saved, language, email: saved.email || userEmail };
      setPreferences(normalized);
      if (normalized.enabled !== wasEnabled) {
        trackEvent('newsletter_change', {
          action: normalized.enabled ? 'subscribe' : 'unsubscribe',
        });
        if (normalized.enabled) markActivation();
      }
      return normalized;
    } catch (saveError) {
      setError(saveError);
      throw saveError;
    } finally {
      setSaving(false);
    }
  }, [followedEntities, hasFollows, items, language, markActivation, notificationDataReady, preferences.enabled, trackEvent, userEmail]);

  const sendTest = useCallback(async (nextPreferences = preferences) => {
    if (!notificationDataReady) throw new EmailNotificationServiceError('EMAIL_DATA_LOADING');
    if (!hasFollows) throw new EmailNotificationServiceError('EMAIL_FOLLOWS_REQUIRED', 409);
    setTesting(true);
    setError(null);
    try {
      const saved = await saveEmailNotificationPreferences(
        { ...nextPreferences, enabled: true, language },
        followedEntities,
        items,
      );
      const normalized = { ...DEFAULT_PREFERENCES, ...saved, language, email: saved.email || userEmail };
      setPreferences(normalized);
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
  }, [followedEntities, hasFollows, items, language, notificationDataReady, preferences, userEmail]);

  useEffect(() => {
    if (
      !preferences.enabled
      || !userId
      || followsLoading
      || followsError
      || updatesLoading
      || !followedEntities.length
      || loadedForUser.current !== userId
    ) return undefined;
    const syncTimeout = setTimeout(() => {
      saveEmailNotificationPreferences({ ...preferences, language }, followedEntities, items)
        .catch(syncError => console.warn('Could not synchronize the notification digest', syncError));
    }, 1800);
    return () => clearTimeout(syncTimeout);
  }, [followSignature, followedEntities, followsError, followsLoading, items, language, preferences, previewSignature, updatesLoading, userId]);

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
