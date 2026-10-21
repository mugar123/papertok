import type { PropsWithChildren } from 'react';
export interface AnalyticsContextValue {
  consent: ReturnType<typeof readAnalyticsConsent>;
  /** Whether a choice is stored at all; until it is, the consent banner asks. */
  decided: boolean;
  updateConsent: (value: string) => Promise<boolean>;
  trackEvent: typeof trackProductEvent;
  markActivation: () => ReturnType<typeof markAnalyticsActivation>;
}

/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { pageview } from '@vercel/analytics';
import { AnalyticsContext } from './contexts.ts';
import { useLocation } from 'react-router-dom';
import { useLanguage } from './LanguageContext.tsx';
import { initializeErrorTracking } from '../services/errorTracking.ts';
import { useAuth } from './AuthContext.tsx';
import {
  ANALYTICS_CONSENT,
  identifyAnalyticsUser,
  markActivation as markAnalyticsActivation,
  normalizeAnalyticsPath,
  readAnalyticsConsent,
  readStoredAnalyticsConsent,
  removeLegacyGoogleAnalyticsCookies,
  sanitizeVercelEvent,
  setAnalyticsConsent,
  trackAcquisition,
  trackDay7Return,
  trackPageView,
  trackProductEvent,
} from '../services/analyticsService.ts';


export function AnalyticsProvider({ children }: PropsWithChildren) {
  const location = useLocation();
  const { language } = useLanguage();
  const { user } = useAuth();
  const [consent, setConsent] = useState(readAnalyticsConsent);
  const [decided, setDecided] = useState(() => readStoredAnalyticsConsent() !== null);

  // Runs for everyone, consent or not: these are leftovers from GA4, and the
  // people carrying them are exactly the ones who once said yes.
  useEffect(() => {
    removeLegacyGoogleAnalyticsCookies();
  }, []);

  useEffect(() => {
    if (consent === ANALYTICS_CONSENT.DENIED) return;
    void initializeErrorTracking();
    trackAcquisition({ language });
  }, [consent, language]);

  // Page views go to both services, keyed on the concrete pathname, and report
  // only the pattern: Vercel Web Analytics counts visits, pages and countries,
  // and PostHog needs the views beside its events to follow a path through the
  // app. <Analytics route> below is what flips `disableAutoTrack` on the
  // injected script; its own `path` prop is deliberately not passed, because
  // that emitter re-fires on a change of PATTERN, and two papers share one —
  // the second was never a view.
  //
  // `route` and `path` carry the SAME normalized value on purpose. Vercel reads
  // `route` as the pattern and `path` as the concrete URL that matched it, but
  // the concrete URL is the one thing that must not travel: the privacy policy
  // promises that reading a paper is reported as `/public/paper/:id` and never
  // says which. `trackPageView` normalizes the same way for PostHog, unless the
  // reader opted in to detailed analytics.
  useEffect(() => {
    if (consent === ANALYTICS_CONSENT.DENIED) return;
    const viewPath = normalizeAnalyticsPath(location.pathname);
    pageview({ route: viewPath, path: viewPath });
    trackPageView(location.pathname);
  }, [consent, location.pathname]);

  useEffect(() => {
    if (consent === ANALYTICS_CONSENT.DENIED) return;
    trackDay7Return();
  }, [consent, location.pathname]);

  // Detailed analytics follows the account: linked on sign-in, unlinked on
  // sign-out. At any other level PostHog never hears about the account.
  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.DETAILED) return;
    identifyAnalyticsUser(user && {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      signInProviders: user.providerData.map(provider => provider.providerId),
    });
  }, [consent, user]);

  const updateConsent = useCallback(async (value: string) => {
    if (!(Object.values(ANALYTICS_CONSENT) as string[]).includes(value)) return false;
    const persisted = await setAnalyticsConsent(value);
    if (persisted) {
      setConsent(value as typeof consent);
      setDecided(true);
    }
    return persisted;
  }, []);

  const trackEvent = useCallback((eventName: string, params?: Record<string, unknown>) => trackProductEvent(eventName, params), []);
  const markActivation = useCallback(() => markAnalyticsActivation(), []);

  const value = useMemo(
    () => ({ consent, decided, updateConsent, trackEvent, markActivation }),
    [consent, decided, updateConsent, trackEvent, markActivation],
  );

  // Passing `route` flips `disableAutoTrack` on the injected script, whose own
  // tracking reads `window.location.pathname`. That used to be a constant —
  // under HashRouter the route lived in the fragment and the pathname was just
  // where the app was served — so `route` was what made page views work at all.
  // Since the router moved to real paths (src/main.tsx), the pathname IS the
  // route, identifier and all, so this prop is now what keeps the script from
  // filing a view under `/public/paper/<the real id>`. The views themselves are
  // emitted above, already normalized.
  const analyticsPath = normalizeAnalyticsPath(location.pathname);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {consent !== ANALYTICS_CONSENT.DENIED ? (
        <Analytics
          mode={import.meta.env.DEV ? 'development' : 'production'}
          route={analyticsPath}
          beforeSend={sanitizeVercelEvent}
        />
      ) : null}
    </AnalyticsContext.Provider>
  );
}

export function useAnalyticsConsent() {
  const context = useContext(AnalyticsContext);
  if (!context) throw new Error('useAnalyticsConsent must be used within an AnalyticsProvider');
  return context;
}
