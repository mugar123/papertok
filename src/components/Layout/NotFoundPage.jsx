import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { House } from '@phosphor-icons/react';
import { useLanguage } from '../../context/LanguageContext';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import './NotFoundPage.css';

// An address the app does not declare. It used to land on /feed without a
// word, which hid a broken link behind a working page (audit 2026-09-23,
// issue 12). The server answers a page load of one with public/404.html (the
// service worker sends navigations to the network, with no fallback); this is
// the same answer for a navigation the app makes itself.
const COPY = {
  es: {
    title: 'No encontramos esta página',
    body: 'Puede que el enlace ya no exista o que esté mal escrito.',
    action: 'Ir al feed',
    documentTitle: 'Página no encontrada | PaperTok',
  },
  en: {
    title: 'We could not find this page',
    body: 'The link may no longer exist, or it may be mistyped.',
    action: 'Go to the feed',
    documentTitle: 'Page not found | PaperTok',
  },
};

export default function NotFoundPage() {
  const { isEnglish } = useLanguage();
  const location = useLocation();
  const copy = COPY[isEnglish ? 'en' : 'es'];
  const metadata = useMemo(() => ({
    title: { es: COPY.es.documentTitle, en: COPY.en.documentTitle },
    description: { es: COPY.es.body, en: COPY.en.body },
    route: location.pathname,
    noIndex: true,
  }), [location.pathname]);
  usePublicPageMetadata(metadata);

  return (
    <main className="not-found-page">
      <div className="not-found-card">
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <Link to="/feed" className="not-found-action">
          <House size={17} aria-hidden="true" />
          {copy.action}
        </Link>
      </div>
    </main>
  );
}
