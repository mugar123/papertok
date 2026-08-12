import { useState } from 'react';
import { BarChart3, Check, LoaderCircle } from 'lucide-react';
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
    decline: 'Ahora no',
  },
  en: {
    title: 'Help us improve PaperTok',
    description: 'We can anonymously measure which pages are used. We do not send searches, papers, interests, or account data.',
    accept: 'Allow analytics',
    activating: 'Enabling…',
    activated: 'Analytics enabled',
    decline: 'Not now',
  },
};

export default function AnalyticsConsentBanner() {
  const location = useLocation();
  const { language } = useLanguage();
  const { user, loading: authLoading, onboardingComplete } = useAuth();
  const { consent, updateConsent } = useAnalyticsConsent();
  const { papers } = useFeed();
  const [acceptanceState, setAcceptanceState] = useState('idle');
  const feedIsVisible = location.pathname === '/'
    && !authLoading
    && Boolean(user)
    && onboardingComplete
    && papers.length > 0;
  if (consent !== null || !feedIsVisible) return null;

  const copy = COPY[language];
  const isAccepting = acceptanceState !== 'idle';

  const handleAccept = async () => {
    if (isAccepting) return;
    setAcceptanceState('loading');
    await new Promise(resolve => window.setTimeout(resolve, 320));
    setAcceptanceState('success');
    await new Promise(resolve => window.setTimeout(resolve, 720));
    await updateConsent(ANALYTICS_CONSENT.GRANTED);
  };

  return (
    <aside
      className={`analytics-consent ${acceptanceState === 'success' ? 'is-success' : ''}`}
      aria-labelledby="analytics-consent-title"
    >
      <span className="analytics-consent-icon" aria-hidden="true"><BarChart3 size={19} /></span>
      <div className="analytics-consent-copy">
        <h2 id="analytics-consent-title">{copy.title}</h2>
        <p>{copy.description}</p>
      </div>
      <div className="analytics-consent-actions">
        <button
          type="button"
          className="analytics-consent-decline"
          disabled={isAccepting}
          onClick={() => updateConsent(ANALYTICS_CONSENT.DENIED)}
        >
          {copy.decline}
        </button>
        <button
          type="button"
          className={`analytics-consent-accept is-${acceptanceState}`}
          disabled={isAccepting}
          aria-live="polite"
          onClick={handleAccept}
        >
          {acceptanceState === 'loading' && <LoaderCircle size={14} aria-hidden="true" />}
          {acceptanceState === 'success' && <Check size={15} aria-hidden="true" />}
          {acceptanceState === 'idle' && copy.accept}
          {acceptanceState === 'loading' && copy.activating}
          {acceptanceState === 'success' && copy.activated}
        </button>
      </div>
    </aside>
  );
}
