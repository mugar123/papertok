/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  ANALYTICS_CONSENT,
  readAnalyticsConsent,
  setAnalyticsConsent,
  trackPageView,
} from '../services/analyticsService';

const AnalyticsContext = createContext(null);

export function AnalyticsProvider({ children }) {
  const location = useLocation();
  const [consent, setConsent] = useState(readAnalyticsConsent);

  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    trackPageView(location.pathname);
  }, [consent, location.pathname]);

  const updateConsent = useCallback(async value => {
    if (!Object.values(ANALYTICS_CONSENT).includes(value)) return false;
    setConsent(value);
    return setAnalyticsConsent(value);
  }, []);

  const value = useMemo(() => ({ consent, updateConsent }), [consent, updateConsent]);

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalyticsConsent() {
  const context = useContext(AnalyticsContext);
  if (!context) throw new Error('useAnalyticsConsent must be used within an AnalyticsProvider');
  return context;
}
