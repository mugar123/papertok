/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AnalyticsContext } from './contexts';
import { useLocation } from 'react-router-dom';
import { useLanguage } from './LanguageContext';
import {
  ANALYTICS_CONSENT,
  markActivation as markAnalyticsActivation,
  readAnalyticsConsent,
  setAnalyticsConsent,
  trackAcquisition,
  trackPageView,
  trackDay7Return,
  trackProductEvent,
} from '../services/analyticsService';

export function AnalyticsProvider({ children }) {
  const location = useLocation();
  const { language } = useLanguage();
  const [consent, setConsent] = useState(readAnalyticsConsent);

  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    trackAcquisition({ language });
  }, [consent, language]);

  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    trackPageView(location.pathname);
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

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalyticsConsent() {
  const context = useContext(AnalyticsContext);
  if (!context) throw new Error('useAnalyticsConsent must be used within an AnalyticsProvider');
  return context;
}
