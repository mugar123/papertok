import { useCallback, useEffect, useRef } from 'react';
import { LogIn, RotateCw, Search } from 'lucide-react';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useGuestFeed } from '../../hooks/useGuestFeed.js';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.js';
import FeedContainer from '../Feed/FeedContainer.jsx';
import './GuestFeedPage.css';

export default function GuestFeedPage({ onReady, onAuthRequired, onOpenPdf, onOpenComments = null }) {
  const { isEnglish, language, setLanguage } = useLanguage();
  const { consent, trackEvent } = useAnalyticsConsent();
  const guestFeed = useGuestFeed();
  const trackedDemoRef = useRef(false);

  useEffect(() => {
    const ready = guestFeed.papers.length > 0 && !guestFeed.loading;
    onReady?.(ready);
    return () => onReady?.(false);
  }, [guestFeed.loading, guestFeed.papers.length, onReady]);

  useEffect(() => {
    if (
      guestFeed.loading
      || guestFeed.papers.length === 0
      || consent !== ANALYTICS_CONSENT.GRANTED
      || trackedDemoRef.current
    ) return undefined;

    let active = true;
    trackEvent('guest_demo_start', { entry_point: 'home', language }).then(tracked => {
      if (active && tracked) trackedDemoRef.current = true;
    });
    return () => {
      active = false;
    };
  }, [consent, guestFeed.loading, guestFeed.papers.length, language, trackEvent]);

  const requestAccount = useCallback((action = 'other') => {
    const contentType = action === 'list' ? 'list' : action === 'other' ? 'other' : 'paper';
    trackEvent('select_content', { content_type: contentType, surface: 'feed' });
    onAuthRequired?.();
  }, [onAuthRequired, trackEvent]);

  return (
    <main className="guest-feed-page">
      <header className="guest-feed-header" aria-label={isEnglish ? 'PaperTok guest navigation' : 'Navegación de invitado de PaperTok'}>
        <div className="guest-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
        <div className="guest-header-actions">
          <button
            type="button"
            className={`guest-header-button ${guestFeed.isRefreshing ? 'is-spinning' : ''}`}
            onClick={guestFeed.refresh}
            aria-label={isEnglish ? 'Refresh papers' : 'Recargar papers'}
          >
            <RotateCw size={17} />
          </button>
          <button type="button" className="guest-language-button" onClick={() => setLanguage(isEnglish ? 'es' : 'en')}>
            {isEnglish ? 'ES' : 'EN'}
          </button>
          <button type="button" className="guest-header-button" onClick={() => requestAccount('other')} aria-label={isEnglish ? 'Search' : 'Buscar'}>
            <Search size={17} />
          </button>
          <button type="button" className="guest-sign-in-button" onClick={() => requestAccount('other')}>
            <LogIn size={15} /> {isEnglish ? 'Sign in' : 'Entrar'}
          </button>
        </div>
      </header>

      <FeedContainer
        source={{ ...guestFeed, publicMode: true, onAuthRequired: requestAccount }}
        scrollKey="guest"
        onOpenPdf={onOpenPdf}
        onSaveToList={() => requestAccount('list')}
        onOpenComments={onOpenComments}
      />
    </main>
  );
}
