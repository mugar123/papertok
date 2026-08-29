import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BarChart3, Check, LoaderCircle, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { ANALYTICS_CONSENT } from '../../services/analyticsService';
import './AnalyticsConsentBanner.css';

const COPY = {
  es: {
    title: 'Ayúdanos a mejorar PaperTok',
    description: 'Podemos medir de forma anónima qué páginas se usan. No enviamos búsquedas, papers, intereses ni datos de tu cuenta.',
    accept: 'Permitir analítica',
    activating: 'Activando…',
    activated: 'Analítica activada',
    dismiss: 'Cerrar y no permitir',
    persistenceError: 'No se pudo guardar tu elección. Inténtalo de nuevo.',
  },
  en: {
    title: 'Help us improve PaperTok',
    description: 'We can anonymously measure which pages are used. We do not send searches, papers, interests, or account data.',
    accept: 'Allow analytics',
    activating: 'Enabling…',
    activated: 'Analytics enabled',
    dismiss: 'Dismiss and do not allow',
    persistenceError: 'Your choice could not be saved. Please try again.',
  },
};

export default function AnalyticsConsentBanner({ guestFeedReady = false }) {
  const location = useLocation();
  const { language } = useLanguage();
  const { user, loading: authLoading, onboardingComplete } = useAuth();
  const { consent, updateConsent } = useAnalyticsConsent();
  const { papers } = useFeed();
  const [acceptanceState, setAcceptanceState] = useState('idle');
  const [declinePending, setDeclinePending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const dismissalTimerRef = useRef(null);
  const prefersReducedMotion = useReducedMotion();
  const feedIsVisible = location.pathname === '/'
    && !authLoading
    && ((Boolean(user) && onboardingComplete && papers.length > 0)
      || (!user && guestFeedReady));

  const copy = COPY[language];
  const isAccepting = acceptanceState === 'loading' || acceptanceState === 'success';
  const decisionInProgress = isAccepting || declinePending;
  const shouldShow = feedIsVisible
    && !dismissed
    && (consent === null || decisionInProgress);

  useEffect(() => () => {
    if (dismissalTimerRef.current) window.clearTimeout(dismissalTimerRef.current);
  }, []);

  const handleAccept = async () => {
    if (decisionInProgress) return;
    setAcceptanceState('loading');
    const persisted = await updateConsent(ANALYTICS_CONSENT.GRANTED);
    if (!persisted) {
      setAcceptanceState('error');
      return;
    }

    setAcceptanceState('success');
    dismissalTimerRef.current = window.setTimeout(
      () => setDismissed(true),
      prefersReducedMotion ? 0 : 620,
    );
  };

  const handleDecline = async () => {
    if (decisionInProgress) return;
    setDeclinePending(true);
    const persisted = await updateConsent(ANALYTICS_CONSENT.DENIED);
    if (persisted) setDismissed(true);
    else setAcceptanceState('error');
    setDeclinePending(false);
  };

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.aside
          key="analytics-consent"
          className={`analytics-consent ${acceptanceState === 'success' ? 'is-success' : ''}`}
          aria-labelledby="analytics-consent-title"
          initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={prefersReducedMotion
            ? { opacity: 0 }
            : { opacity: 0, y: 16, scale: 0.975, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
          transition={prefersReducedMotion
            ? { duration: 0 }
            : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="analytics-consent-icon" aria-hidden="true"><BarChart3 size={19} /></span>
          <div className="analytics-consent-copy">
            <h2 id="analytics-consent-title">{copy.title}</h2>
            <p>{copy.description}</p>
          </div>
          <div className="analytics-consent-actions">
            <button
              type="button"
              className={`analytics-consent-accept is-${acceptanceState}`}
              disabled={decisionInProgress}
              aria-live="polite"
              onClick={handleAccept}
            >
              {acceptanceState === 'loading' && <LoaderCircle size={14} aria-hidden="true" />}
              {acceptanceState === 'success' && <Check size={15} aria-hidden="true" />}
              {acceptanceState === 'idle' && copy.accept}
              {acceptanceState === 'loading' && copy.activating}
              {acceptanceState === 'success' && copy.activated}
              {acceptanceState === 'error' && copy.accept}
            </button>
          </div>
          <button
            type="button"
            className="analytics-consent-dismiss"
            disabled={decisionInProgress}
            onClick={handleDecline}
            aria-label={copy.dismiss}
            title={copy.dismiss}
          >
            <X size={14} aria-hidden="true" />
          </button>
          {acceptanceState === 'error' && (
            <p className="analytics-consent-error" role="alert">{copy.persistenceError}</p>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
