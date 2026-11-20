import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmailNotificationServiceError, getReactivationConsent, recordDigestVisit, saveReactivationConsent } from '../services/email-notification-service.ts';

const HOUR_MS = 60 * 60 * 1000;

export function useDigestReactivation(uid: string | null, subscribed: boolean, emailVerified: boolean) {
  const [consent, setConsent] = useState<Awaited<ReturnType<typeof getReactivationConsent>> | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const subscriberUid = subscribed ? uid : null;
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
  }, [refresh, revision, uid]);

  const enabled = subscribed && consent?.enabled === true;
  useEffect(() => {
    if (!enabled) {
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
  }, [emailVerified, enabled, refresh, revision, uid]);

  const loading = subscribed && consent === null && !unavailable;
  const known = consent !== null;
  return useMemo(() => ({ enabled, known, loading, unavailable, refresh, save }), [enabled, known, loading, unavailable, refresh, save]);
}
