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

// The persist is synchronous in effect, so "Enabling…" used to last a frame:
// the button changed its text twice inside thirty milliseconds. A beat long
// enough to read makes the three steps — pressed, working, done — legible.
const ACCEPT_BEAT_MS = 320;
// How long the confirmation stays on screen before the banner takes its leave.
const CONFIRMED_HOLD_MS = 800;

const ACCEPT_FACES = ['idle', 'loading', 'success'];

// Where a face of the button sits relative to the current step: the ones
// already passed have gone up, the ones still to come wait below. An error
// shows the idle face again — the label is the invitation to try again.
function facePosition(face, state) {
  const current = state === 'error' ? 'idle' : state;
  const order = ACCEPT_FACES.indexOf(face) - ACCEPT_FACES.indexOf(current);
  return order === 0 ? 'is-current' : order < 0 ? 'is-past' : 'is-next';
}

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
  const currentLabel = acceptanceState === 'loading'
    ? copy.activating
    : acceptanceState === 'success'
      ? copy.activated
      : copy.accept;
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
    const [persisted] = await Promise.all([
      updateConsent(ANALYTICS_CONSENT.GRANTED),
      new Promise(resolve => window.setTimeout(resolve, prefersReducedMotion ? 0 : ACCEPT_BEAT_MS)),
    ]);
    if (!persisted) {
      setAcceptanceState('error');
      return;
    }

    setAcceptanceState('success');
    dismissalTimerRef.current = window.setTimeout(
      () => setDismissed(true),
      prefersReducedMotion ? 0 : CONFIRMED_HOLD_MS,
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
            : { opacity: 0, y: 20, scale: 0.97, transition: { duration: 0.3, ease: [0.4, 0, 1, 1] } }}
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
              onClick={handleAccept}
            >
              {/* One label is announced; the three faces below are what is
                  seen. They are all in the DOM, stacked in one cell, so the
                  button is as wide as its widest label from the start and
                  never changes size between steps — each step rises into
                  place while the last one lifts away. */}
              <span className="visually-hidden" aria-live="polite">{currentLabel}</span>
              <span className="analytics-consent-accept-faces" aria-hidden="true">
                <span className={`analytics-consent-accept-face ${facePosition('idle', acceptanceState)}`} data-face="idle">
                  {copy.accept}
                </span>
                <span className={`analytics-consent-accept-face ${facePosition('loading', acceptanceState)}`} data-face="loading">
                  <LoaderCircle size={14} />
                  {copy.activating}
                </span>
                <span className={`analytics-consent-accept-face ${facePosition('success', acceptanceState)}`} data-face="success">
                  <Check size={15} />
                  {copy.activated}
                </span>
              </span>
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
