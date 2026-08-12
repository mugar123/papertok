import { BarChart3 } from 'lucide-react';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { useLanguage } from '../../context/LanguageContext';
import { ANALYTICS_CONSENT } from '../../services/analyticsService';
import './AnalyticsConsentBanner.css';

const COPY = {
  es: {
    title: 'Ayúdanos a mejorar PaperTok',
    description: 'Podemos medir de forma anónima qué páginas se usan. No enviamos búsquedas, papers, intereses ni datos de tu cuenta.',
    accept: 'Permitir analítica',
    decline: 'Ahora no',
  },
  en: {
    title: 'Help us improve PaperTok',
    description: 'We can anonymously measure which pages are used. We do not send searches, papers, interests, or account data.',
    accept: 'Allow analytics',
    decline: 'Not now',
  },
};

export default function AnalyticsConsentBanner() {
  const { language } = useLanguage();
  const { consent, updateConsent } = useAnalyticsConsent();
  if (consent !== null) return null;

  const copy = COPY[language];
  return (
    <aside className="analytics-consent" aria-labelledby="analytics-consent-title">
      <span className="analytics-consent-icon" aria-hidden="true"><BarChart3 size={19} /></span>
      <div className="analytics-consent-copy">
        <h2 id="analytics-consent-title">{copy.title}</h2>
        <p>{copy.description}</p>
      </div>
      <div className="analytics-consent-actions">
        <button type="button" className="analytics-consent-decline" onClick={() => updateConsent(ANALYTICS_CONSENT.DENIED)}>
          {copy.decline}
        </button>
        <button type="button" className="analytics-consent-accept" onClick={() => updateConsent(ANALYTICS_CONSENT.GRANTED)}>
          {copy.accept}
        </button>
      </div>
    </aside>
  );
}
