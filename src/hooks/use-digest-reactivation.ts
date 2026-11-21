import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmailNotificationServiceError, getReactivationConsent, recordDigestVisit, saveReactivationConsent } from '../services/email-notification-service.ts';
import type { UseDigestReactivation } from './digest-reactivation-types.ts';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Reminder consent for the signed-in account. `subscribed` is null when the
 * digest preferences could not be read: consent is still read, so a reader who
 * gave it can withdraw it, but only a confirmed subscription can grant consent
 * or record a visit. Withdrawing needs neither read.
 */
export const useDigestReactivation: UseDigestReactivation = (uid, subscribed, emailVerified) => {
  const [consent, setConsent] = useState<Awaited<ReturnType<typeof getReactivationConsent>> | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const subscriberUid = subscribed !== false ? uid : null;
  const [loadedUid, setLoadedUid] = useState(subscriberUid);
  const session = useRef<AbortController | null>(null);
  const refreshAttempt = useRef(0);
  const lastAttempt = useRef<{ revision: number; hour: number } | null>(null);
  if (loadedUid !== subscriberUid) {
    setLoadedUid(subscriberUid);
    setConsent(null);
    setUnavailable(false);
  }

  const refresh = useCallback(async () => {
    const signal = session.current?.signal;
    if (!uid || !signal) return;
    const attempt = ++refreshAttempt.current;
    try {
      const current = await getReactivationConsent(uid, signal);
      if (!signal.aborted && attempt === refreshAttempt.current) {
        setConsent(current);
        setUnavailable(false);
      }
    } catch {
      if (!signal.aborted && attempt === refreshAttempt.current) setUnavailable(true);
    }
  }, [uid]);

  useEffect(() => {
    if (!subscriberUid) return;
    const controller = new AbortController();
    session.current = controller;
    void refresh();
    return () => {
      controller.abort();
      session.current = null;
      lastAttempt.current = null;
    };
  }, [refresh, subscriberUid]);

  const revision = consent?.revision;
  const save = useCallback(async (enabled: boolean) => {
    const signal = session.current?.signal;
    if (!uid || !signal) throw new EmailNotificationServiceError('EMAIL_AUTH_REQUIRED', 401);
    if (enabled && subscribed !== true) throw new EmailNotificationServiceError('EMAIL_REACTIVATION_REQUIRES_DIGEST', 409);
    if (enabled && revision === undefined) throw new EmailNotificationServiceError('EMAIL_REACTIVATION_CHANGED', 409);
    let saved;
    try {
      saved = await saveReactivationConsent(uid, enabled, revision, signal);
    } catch (error) {
      if (!signal.aborted && error instanceof EmailNotificationServiceError && error.code === 'EMAIL_REACTIVATION_CHANGED') await refresh();
      throw error;
    }
    if (!signal.aborted) {
      // A retry may have read the old choice before this save landed.
      refreshAttempt.current++;
      setConsent(saved);
      setUnavailable(false);
    }
  }, [refresh, revision, subscribed, uid]);

  const enabled = subscribed !== false && consent?.enabled === true;
  const recording = enabled && subscribed === true;
  useEffect(() => {
    if (!recording) {
      lastAttempt.current = null;
      return;
    }
    if (!uid || !emailVerified || revision === undefined) return;
    const controller = new AbortController();
    const record = () => {
      if (document.visibilityState !== 'visible') return;
      const hour = Math.floor(Date.now() / HOUR_MS);
      if (lastAttempt.current?.revision === revision && lastAttempt.current.hour >= hour) return;
      lastAttempt.current = { revision, hour };
      void recordDigestVisit(uid, revision, controller.signal).catch(async error => {
        if (!controller.signal.aborted && error instanceof EmailNotificationServiceError && error.code === 'EMAIL_REACTIVATION_CHANGED') await refresh();
      });
    };
    document.addEventListener('visibilitychange', record);
    const initialVisit = setTimeout(record, 0);
    return () => {
      clearTimeout(initialVisit);
      document.removeEventListener('visibilitychange', record);
      controller.abort();
    };
  }, [emailVerified, recording, refresh, revision, uid]);

  const loading = subscribed !== false && consent === null && !unavailable;
  const known = consent !== null;
  return useMemo(() => ({ enabled, known, loading, unavailable, refresh, save }), [enabled, known, loading, unavailable, refresh, save]);
};
