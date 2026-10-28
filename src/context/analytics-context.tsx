import { useEffect } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { pageview } from '@vercel/analytics';
import { useLocation } from 'react-router-dom';
import { useLanguage } from './language-context.tsx';
import { useAuth } from './auth-context.tsx';
import { useAnalyticsConsent } from './privacy-context.tsx';
import {
  ANALYTICS_CONSENT, normalizeAnalyticsPath,
  sanitizeVercelEvent, trackAcquisition, trackDay7Return, trackPageView,
} from '../services/analytics-service.ts';

export default function AnalyticsEffects() {
  const location = useLocation();
  const { language } = useLanguage();
  const { loading: authLoading } = useAuth();
  const { consent } = useAnalyticsConsent();

  useEffect(() => {
    if (authLoading || consent === ANALYTICS_CONSENT.DENIED) return;
    void trackAcquisition({ language });
  }, [authLoading, consent, language]);

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
  // promises that reading a paper is reported as `/paper/:id` and never
  // says which. `trackPageView` normalizes PostHog page views too; product
  // events carry paper identifiers separately.
  useEffect(() => {
    if (authLoading || consent === ANALYTICS_CONSENT.DENIED) return;
    const viewPath = normalizeAnalyticsPath(location.pathname);
    pageview({ route: viewPath, path: viewPath });
    void trackPageView(location.pathname);
  }, [authLoading, consent, location.pathname]);

  useEffect(() => {
    if (authLoading || consent === ANALYTICS_CONSENT.DENIED) return;
    void trackDay7Return();
  }, [authLoading, consent, location.pathname]);

  return (
    <Analytics
      mode={import.meta.env.DEV ? 'development' : 'production'}
      route={normalizeAnalyticsPath(location.pathname)}
      beforeSend={sanitizeVercelEvent}
    />
  );
}
