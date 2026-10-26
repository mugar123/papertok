import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { House } from '@phosphor-icons/react';
import { useAuth } from '../../context/auth-context.tsx';
import { usePublicPageMetadata } from '../../hooks/use-public-page-metadata.ts';
import Petri from '../onboarding/petri.tsx';
import PrivacyPopover from '../public/privacy-popover.tsx';
import './not-found-page.css';

// An address the app does not declare. It used to land on /feed without a
// word, which hid a broken link behind a working page (audit 2026-09-23,
// issue 12). The server answers a page load of one with public/404.html (the
// service worker sends navigations to the network, with no fallback); this is
// the same answer for a navigation the app makes itself.
const COPY = {
  en: {
    title: 'We could not find this page',
    body: 'The link may no longer exist, or it may be mistyped.',
    action: 'Go to the feed',
    documentTitle: 'Page not found | PaperTok',
  },
};

export default function NotFoundPage() {
  const location = useLocation();
  const { user, loading } = useAuth();
  const copy = COPY.en;
  const metadata = useMemo(() => ({
    title: { en: COPY.en.documentTitle },
    description: { en: COPY.en.body },
    route: location.pathname,
    noIndex: true,
  }), [location.pathname]);
  usePublicPageMetadata(metadata);

  return (
    <main className="not-found-page">
      {/* A dead shared link is opened without an account more often than
          with one, and a visitor has no Settings: the analytics switch is at
          the top, as on every other page a link opens. A session has Settings,
          and one still being restored is not a visitor yet. */}
      {!user && !loading && (
        <div className="not-found-bar">
          <PrivacyPopover />
        </div>
      )}
      <div className="not-found-card">
        <Petri pose="lost" code="404" className="not-found-petri" />
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
