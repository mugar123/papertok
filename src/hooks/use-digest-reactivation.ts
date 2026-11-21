import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmailNotificationServiceError, getReactivationConsent, recordDigestVisit, saveReactivationConsent } from '../services/email-notification-service.ts';
import type { UseDigestReactivation } from './digest-reactivation-types.ts';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Reminder consent for the signed-in account. `subscribed` is null when the
 * digest preferences could not be read: consent is still read, so a reader who
 * gave it can withdraw it, but only a confirmed subscription can grant consent
 * or record a visit. Withdrawing needs neither read.
 * The hook reads consent by itself only while the digest is on or unknown.
 * `refresh` reads it for any signed-in account, so Settings can show and
 * withdraw consent another tab gave while this tab read the digest as off.
 */
export const useDigestReactivation: UseDigestReactivation = (uid, subscribed, emailVerified) => {
  const subscriberUid = subscribed !== false ? uid : null;
  // Every answer and failed read belongs to the account and digest state it
  // was asked under, so one that lands after either changed is never shown.
  const scope = `${uid ?? ''}|${subscriberUid ?? ''}`;
  const [answer, setAnswer] = useState<{ scope: string; consent: Awaited<ReturnType<typeof getReactivationConsent>> } | null>(null);
  const [failedScope, setFailedScope] = useState<string | null>(null);
  // A changed scope also clears what an earlier visit to it left, so going
  // back to it does not show an old answer while the new read is in flight.
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setAnswer(null);
    setFailedScope(null);
  }
  const consent = answer?.scope === scope ? answer.consent : null;
  const unavailable = failedScope === scope;
  // The scope now, set before any passive effect (the dialog's read on opening
  // included) runs, so a request from an earlier scope can tell it is stale.
  const currentScope = useRef(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
  }, [scope]);
  const session = useRef<AbortController | null>(null);
  const refreshAttempt = useRef(0);
  const lastAttempt = useRef<{ revision: number; hour: number } | null>(null);

  const refresh = useCallback(async () => {
    const signal = session.current?.signal;
    // A callback from an earlier scope must not invalidate the current scope's reads.
    if (!uid || !signal || currentScope.current !== scope) return;
    const attempt = ++refreshAttempt.current;
    const current = () => !signal.aborted && attempt === refreshAttempt.current && currentScope.current === scope;
    try {
      const read = await getReactivationConsent(uid, signal);
      if (current()) {
        setAnswer({ scope, consent: read });
        setFailedScope(null);
      }
    } catch {
      if (current()) setFailedScope(scope);
    }
  }, [scope, uid]);

  useEffect(() => {
    if (!uid) return;
    const controller = new AbortController();
    session.current = controller;
    return () => {
      controller.abort();
      session.current = null;
      lastAttempt.current = null;
    };
  }, [uid]);

  useEffect(() => {
    if (subscriberUid) void refresh();
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
    // After a scope change, the new scope's own read shows the result.
    if (!signal.aborted && currentScope.current === scope) {
      // A retry may have read the old choice before this save landed.
      refreshAttempt.current++;
      setAnswer({ scope, consent: saved });
      setFailedScope(current => (current === scope ? null : current));
    }
  }, [refresh, revision, scope, subscribed, uid]);

  const enabled = consent?.enabled === true;
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
