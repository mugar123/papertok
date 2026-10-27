import { Component, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { ComponentType, PropsWithChildren } from 'react';
import { useAuth } from './auth-context.tsx';
import { AnalyticsContext } from './contexts.ts';
import { loadOptionalModule } from '../utils/module-load-recovery.ts';
import {
  ANALYTICS_CONSENT, ANALYTICS_CONSENT_KEY, readAnalyticsConsent, identifyAnalyticsUser,
  removeLegacyGoogleAnalyticsCookies, setAnalyticsConsent,
  trackProductEvent, markActivation as markAnalyticsActivation,
  type ProductAnalyticsEvent,
} from '../services/analytics-service.ts';

export interface AnalyticsContextValue {
  consent: ReturnType<typeof readAnalyticsConsent>;
  updateConsent: (value: string) => Promise<boolean>;
  trackEvent: typeof trackProductEvent;
  markActivation: () => ReturnType<typeof markAnalyticsActivation>;
}

function UnavailableAnalytics() { return null; }

const AnalyticsEffects = lazy<ComponentType>(async () => {
  const module = await loadOptionalModule(() => import('./analytics-context.tsx'));
  return module ?? { default: UnavailableAnalytics };
});

// An optional reporting component must not replace the reader with the app's
// error screen if its SDK throws during render or a React effect.
class AnalyticsBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.warn('Analytics unavailable', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

/* eslint-disable react-refresh/only-export-components -- this provider exports its hook; context identity is owned by contexts.ts */
export function PrivacyProvider({ children }: PropsWithChildren) {
  const [consent, setConsent] = useState(readAnalyticsConsent);
  const { user, loading: authLoading } = useAuth();

  // Account resets must survive a blocked reporting component. Register the
  // identity change before child effects can enqueue events for this commit.
  useLayoutEffect(() => {
    if (authLoading && !user) return;
    const identify = () => { void identifyAnalyticsUser(user && { uid: user.uid }); };
    identify();
    window.addEventListener('online', identify);
    return () => window.removeEventListener('online', identify);
  }, [authLoading, consent, user]);



  useEffect(() => { removeLegacyGoogleAnalyticsCookies(); }, []);

  const updateConsent = useCallback(async (value: string) => {
    if (!(Object.values(ANALYTICS_CONSENT) as string[]).includes(value)) return false;
    const persisted = await setAnalyticsConsent(value);
    if (persisted) {
      setConsent(value as typeof consent);
    }
    return persisted;
  }, []);

  useEffect(() => {
    const syncPreference = (event: StorageEvent) => {
      if (event.key === ANALYTICS_CONSENT_KEY || event.key === null) {
        void updateConsent(readAnalyticsConsent());
      }
    };
    window.addEventListener('storage', syncPreference);
    return () => window.removeEventListener('storage', syncPreference);
  }, [updateConsent]);

  const trackEvent = useCallback((eventName: ProductAnalyticsEvent, params?: Record<string, unknown>) => trackProductEvent(eventName, params), []);
  const markActivation = useCallback(() => markAnalyticsActivation(), []);

  const value = useMemo(
    () => ({ consent, updateConsent, trackEvent, markActivation }),
    [consent, updateConsent, trackEvent, markActivation],
  );

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {consent !== ANALYTICS_CONSENT.DENIED && (
        <AnalyticsBoundary>
          <Suspense fallback={null}><AnalyticsEffects /></Suspense>
        </AnalyticsBoundary>
      )}
    </AnalyticsContext.Provider>
  );
}

export function useAnalyticsConsent() {
  const context = useContext(AnalyticsContext);
  if (!context) throw new Error('useAnalyticsConsent must be used within a PrivacyProvider');
  return context;
}
