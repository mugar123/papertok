/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { AnalyticsContext } from './contexts';
import { useLocation } from 'react-router-dom';
import { useLanguage } from './LanguageContext';
import {
  ANALYTICS_CONSENT,
  markActivation as markAnalyticsActivation,
  normalizeAnalyticsPath,
  readAnalyticsConsent,
  removeLegacyGoogleAnalyticsCookies,
  sanitizeAnalyticsEventUrl,
  setAnalyticsConsent,
  trackAcquisition,
  trackDay7Return,
  trackProductEvent,
} from '../services/analyticsService';

// Declared once, outside the component: `<Analytics />` re-registers its
// `beforeSend` on every change of identity, so an inline arrow would re-register
// it on every render of the whole app.
const sanitizeOutgoingEvent = event => ({ ...event, url: sanitizeAnalyticsEventUrl(event.url) });

export function AnalyticsProvider({ children }) {
  const location = useLocation();
  const { language } = useLanguage();
  const [consent, setConsent] = useState(readAnalyticsConsent);

  // Runs for everyone, consent or not: these are leftovers from GA4, and the
  // people carrying them are exactly the ones who once said yes.
  useEffect(() => {
    removeLegacyGoogleAnalyticsCookies();
  }, []);

  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    trackAcquisition({ language });
  }, [consent, language]);

  // Page views used to be sent from here, next to this. They are not any more:
  // <Analytics /> below emits them from `route`/`path`, and a second emitter
  // would count every visit twice.
  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    trackDay7Return();
  }, [consent, location.pathname]);

  const updateConsent = useCallback(async value => {
    if (!Object.values(ANALYTICS_CONSENT).includes(value)) return false;
    const persisted = await setAnalyticsConsent(value);
    if (persisted) setConsent(value);
    return persisted;
  }, []);

  const trackEvent = useCallback((eventName, params) => trackProductEvent(eventName, params), []);
  const markActivation = useCallback(() => markAnalyticsActivation(), []);

  const value = useMemo(
    () => ({ consent, updateConsent, trackEvent, markActivation }),
    [consent, updateConsent, trackEvent, markActivation],
  );

  // `route` and `path` deliberately carry the SAME normalized value. Vercel
  // reads `route` as the pattern and `path` as the concrete URL that matched it,
  // but the concrete URL is the one thing that must not travel: the privacy
  // policy promises that reading a paper is reported as `/public/paper/:id` and
  // never says which. So both dimensions get the pattern.
  //
  // Passing `route` at all is also what makes this work under HashRouter:
  // it flips `disableAutoTrack` on the injected script, whose own tracking reads
  // `location.pathname` — `/` for every route in this app, since the route
  // lives in the fragment.
  const analyticsPath = normalizeAnalyticsPath(location.pathname);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {consent === ANALYTICS_CONSENT.GRANTED ? (
        <Analytics
          mode={import.meta.env.DEV ? 'development' : 'production'}
          route={analyticsPath}
          path={analyticsPath}
          beforeSend={sanitizeOutgoingEvent}
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
