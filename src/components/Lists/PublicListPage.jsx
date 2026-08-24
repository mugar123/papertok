import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, Check, Quote, RefreshCw, Share2 } from 'lucide-react';
import { getCategoryLabel } from '../../data/categories';
import ScientificText from '../ScientificText.js';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import { readPublicList } from '../../services/publicListService.js';
import { safeDoiUrl, safeExternalUrl } from '../../utils/externalUrl.js';
import { getPublicListPath, getPublicListUrl, getPublicPaperPath } from '../../utils/publicNavigation.js';
import { isReadTimeout, patientRead } from '../../utils/boundedRead.js';
import { shareOrCopyLink } from '../../utils/shareLink.js';
import { copyText } from '../../utils/clipboard.js';
import './PublicListPage.css';

function arxivUrl(arxivId) {
  const normalized = String(arxivId || '').trim();
  return /^(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/i.test(normalized)
    ? `https://arxiv.org/abs/${encodeURIComponent(normalized).replace('%2F', '/')}`
    : '';
}

function getPublicPaperDestination(paper) {
  const path = getPublicPaperPath(paper);
  if (path) {
    return { href: path, internal: true };
  }

  const href = safeExternalUrl(paper?.openUrl)
    || safeDoiUrl(paper?.doi)
    || arxivUrl(paper?.arxivId);
  return href ? { href, internal: false } : null;
}

function formatDate(value, locale) {
  if (!value) return '';
  const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

function PaperLink({ destination, label, children }) {
  if (!destination) return children;
  if (destination.internal) {
    return <Link to={destination.href} aria-label={label}>{children}</Link>;
  }
  return (
    <a href={destination.href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
    </a>
  );
}

function AuthCta({ user, onAuthRequired, label }) {
  if (user) return <Link className="public-list-auth-cta" to="/lists">{label}</Link>;
  if (onAuthRequired) {
    return <button type="button" className="public-list-auth-cta" onClick={onAuthRequired}>{label}</button>;
  }
  return <Link className="public-list-auth-cta" to="/">{label}</Link>;
}

export default function PublicListPage({ shareId: shareIdProp, onAuthRequired }) {
  const params = useParams();
  const shareId = shareIdProp || params.shareId;
  const { isEnglish, locale } = useLanguage();
  const { user, onboardingComplete, profileLoadError } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  const [publicList, setPublicList] = useState(null);
  const [status, setStatus] = useState('loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [shareState, setShareState] = useState(null);
  const shareTimer = useRef(null);

  // Signed in, the app Navbar owns the top of the screen (App.jsx shows it for
  // /public/list/* too); signed out this is the standalone shared-link page and
  // keeps its own brand header. The condition has to track App.jsx's `showNavbar`
  // or the page ends up with two headers, or with none.
  const hasAppChrome = Boolean(user) && Boolean(onboardingComplete) && !profileLoadError;

  useEffect(() => {
    let active = true;
    // The retry loop outlives the promise, so leaving the page must stop it.
    const controller = new AbortController();

    const apply = (result) => {
      if (!active) return;
      setPublicList(result);
      // `readPublicList` throws rather than returning null when the backend
      // never answered, so a null here really is the server saying "no such
      // list" — this branch can be trusted again.
      setStatus(result ? 'ready' : 'not-found');
    };

    // A share link is the whole page: with no bound, a stalled read left a
    // visitor on the spinner forever with nothing to press. And a bound alone
    // is not enough — a mute connection comes back as a rejection, not as a
    // silence, so "the list could not be loaded" used to appear for a list
    // that was perfectly fine. It stays a wait until an error says otherwise.
    patientRead(() => readPublicList(shareId), {
      attempts: 3,
      label: 'public list',
      signal: controller.signal,
      onSlow: (attemptNumber, info) => {
        if (active) setStatus(info?.offline ? 'offline' : 'slow');
      },
      onLateResult: apply,
    })
      .then(apply)
      .catch(error => {
        if (isReadTimeout(error)) {
          // Budget spent, loop alive: `onLateResult` can still open the list.
          console.warn('The public list did not answer in time', error);
          if (active) setStatus('stalled');
          return;
        }
        console.error('Error loading public list:', error);
        if (active) setStatus(error?.code === 'PUBLIC_LISTS_UNSUPPORTED_IN_DEMO' ? 'unsupported' : 'error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadToken, shareId]);

  const updatedAt = useMemo(
    () => formatDate(publicList?.updatedAt, locale),
    [locale, publicList?.updatedAt],
  );

  useEffect(() => () => clearTimeout(shareTimer.current), []);

  // The share sheet where there is one, the clipboard where there is not —
  // same helper the owner's Lists page uses, so a link shared from here and a
  // link shared from there are produced the same way. A dismissed sheet ends
  // silently: closing it was a decision, not a failure.
  const handleShare = async () => {
    const url = getPublicListUrl(shareId);
    if (!url) return;

    clearTimeout(shareTimer.current);
    const restingState = () => {
      shareTimer.current = setTimeout(() => setShareState(null), 2400);
    };

    try {
      const outcome = await shareOrCopyLink({ url, title: publicList?.title, copy: copyText });
      if (outcome === 'shared') {
        trackEvent('share', { method: 'native', content_type: 'list', surface: 'lists' });
        setShareState(null);
      } else if (outcome === 'copied') {
        trackEvent('share', { method: 'clipboard', content_type: 'list', surface: 'lists' });
        setShareState('copied');
        restingState();
      } else {
        setShareState(null);
      }
    } catch (error) {
      console.error('Public list link could not be shared:', error);
      setShareState('error');
      restingState();
    }
  };

  const metadata = useMemo(() => {
    const fallbackDescription = {
      en: 'Explore a public scientific reading list curated on PaperTok.',
      es: 'Explora una lista pública de lectura científica creada en PaperTok.',
    };
    return {
      route: getPublicListPath(shareId),
      title: publicList ? {
        en: `${publicList.title} | PaperTok public list`,
        es: `${publicList.title} | Lista pública de PaperTok`,
      } : {
        en: 'Public reading list | PaperTok',
        es: 'Lista pública de lectura | PaperTok',
      },
      description: publicList?.description || fallbackDescription,
      imageAlt: {
        en: 'A public scientific reading list on PaperTok',
        es: 'Una lista pública de lectura científica en PaperTok',
      },
      noIndex: status !== 'ready',
    };
  }, [publicList, shareId, status]);
  usePublicPageMetadata(metadata);

  const copy = isEnglish ? {
    brand: 'PaperTok',
    publicList: 'Public reading list',
    loading: 'Opening public list...',
    notFoundTitle: 'This list is not available',
    notFoundBody: 'It may have been unpublished or the link may be incomplete.',
    errorTitle: 'The list could not be loaded',
    errorBody: 'Check your connection and try again.',
    slowTitle: 'Still opening this list',
    slowBody: 'This is taking longer than usual. Still trying.',
    stalledTitle: 'Still opening this list',
    stalledBody: 'This is taking unusually long. We are still trying in the background.',
    offlineTitle: 'Still opening this list',
    offlineBody: 'There seems to be no connection. It will open on its own when it comes back.',
    unsupportedTitle: 'Public lists are unavailable in demo mode',
    unsupportedBody: 'Open this link in the full PaperTok app.',
    retry: 'Try again',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    updated: date => `Updated ${date}`,
    citations: count => `${count.toLocaleString(locale)} citations`,
    open: title => `Open ${title}`,
    empty: 'This public list does not contain any papers yet.',
    authCta: user ? 'Open my lists' : 'Sign in to create a list',
    share: 'Share',
    shareCopied: 'Link copied',
    shareError: 'Could not copy the link',
  } : {
    brand: 'PaperTok',
    publicList: 'Lista pública de lectura',
    loading: 'Abriendo lista pública...',
    notFoundTitle: 'Esta lista no está disponible',
    notFoundBody: 'Puede que se haya dejado de compartir o que el enlace esté incompleto.',
    errorTitle: 'No se pudo cargar la lista',
    errorBody: 'Comprueba tu conexión e inténtalo de nuevo.',
    slowTitle: 'Seguimos abriendo la lista',
    slowBody: 'Está tardando más de lo normal. Seguimos intentándolo.',
    stalledTitle: 'Seguimos abriendo la lista',
    stalledBody: 'Está tardando muchísimo. Seguimos intentándolo por detrás.',
    offlineTitle: 'Seguimos abriendo la lista',
    offlineBody: 'Parece que no hay conexión. Se abrirá sola en cuanto vuelva.',
    unsupportedTitle: 'Las listas públicas no están disponibles en el modo demo',
    unsupportedBody: 'Abre este enlace en la aplicación completa de PaperTok.',
    retry: 'Reintentar',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    updated: date => `Actualizada el ${date}`,
    citations: count => `${count.toLocaleString(locale)} citas`,
    open: title => `Abrir ${title}`,
    empty: 'Esta lista pública aún no contiene papers.',
    authCta: user ? 'Abrir mis listas' : 'Inicia sesión para crear una lista',
    share: 'Compartir',
    shareCopied: 'Enlace copiado',
    shareError: 'No se pudo copiar el enlace',
  };

  const pageClass = `public-list-page${hasAppChrome ? ' public-list-page--app' : ''}`;

  if (status !== 'ready') {
    // 'loading', 'slow' and 'offline' are all still waits: they keep the
    // spinner and the read behind them running. Only the other three are
    // outcomes, and only 'error' is worth a Try again.
    const waiting = status === 'loading' || status === 'slow'
      || status === 'offline' || status === 'stalled';
    const stateCopy = status === 'not-found'
      ? [copy.notFoundTitle, copy.notFoundBody]
      : status === 'unsupported'
        ? [copy.unsupportedTitle, copy.unsupportedBody]
        : status === 'error'
          ? [copy.errorTitle, copy.errorBody]
          : status === 'stalled'
            ? [copy.stalledTitle, copy.stalledBody]
            : status === 'offline'
              ? [copy.offlineTitle, copy.offlineBody]
              : status === 'slow'
                ? [copy.slowTitle, copy.slowBody]
                : [copy.loading, ''];
    return (
      <main className={pageClass}>
        {!hasAppChrome && (
          <header className="public-list-brand">
            <Link to="/">{copy.brand}</Link>
            <AuthCta user={user} onAuthRequired={onAuthRequired} label={copy.authCta} />
          </header>
        )}
        <section className="public-list-status" aria-live="polite" aria-busy={waiting}>
          {waiting ? <span className="public-list-spinner" aria-hidden="true" /> : <BookOpen size={30} />}
          <h1>{stateCopy[0]}</h1>
          {stateCopy[1] && <p>{stateCopy[1]}</p>}
          {(status === 'error' || status === 'stalled') && (
            <button type="button" onClick={() => {
              setStatus('loading');
              setReloadToken(token => token + 1);
            }}>
              <RefreshCw size={16} /> {copy.retry}
            </button>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className={pageClass}>
      {!hasAppChrome && (
        <header className="public-list-brand">
          <Link to="/">{copy.brand}</Link>
          <div className="public-list-brand-actions">
            <span>{copy.publicList}</span>
            <AuthCta user={user} onAuthRequired={onAuthRequired} label={copy.authCta} />
          </div>
        </header>
      )}

      <div className="public-list-content">
        <section className="public-list-heading">
          <p className="public-list-kicker"><BookOpen size={16} /> {copy.publicList}</p>
          <h1>{publicList.title}</h1>
          {publicList.description && <p className="public-list-description">{publicList.description}</p>}
          <div className="public-list-meta">
            <span>{copy.papers(publicList.paperCount)}</span>
            {updatedAt && <span>{copy.updated(updatedAt)}</span>}
          </div>
          <div className="public-list-actions">
            <button
              type="button"
              className="public-list-share"
              onClick={handleShare}
              data-state={shareState || 'idle'}
            >
              {shareState === 'copied' ? <Check size={16} /> : <Share2 size={16} />}
              {copy.share}
            </button>
            {/* The confirmation is a sibling, not the button's own label: a
                button whose text changes under the cursor moves the thing you
                just pressed, and screen readers re-announce the control rather
                than the outcome. */}
            <span className="public-list-share-feedback" role="status" aria-live="polite">
              {shareState === 'copied' ? copy.shareCopied : shareState === 'error' ? copy.shareError : ''}
            </span>
          </div>
        </section>

        <section className="public-list-papers" aria-label={copy.papers(publicList.paperCount)}>
          {publicList.papers.map((paper, index) => {
            const destination = getPublicPaperDestination(paper);
            return (
              <article className="public-list-paper" key={paper.id}>
                <span className="public-list-paper-index">{String(index + 1).padStart(2, '0')}</span>
                <div className="public-list-paper-body">
                  <div className="public-list-paper-tags">
                    {/* The stored category is the raw arXiv slug (gr-qc); every
                        other screen shows the human label, so this one does too. */}
                    {paper.category && <span>{getCategoryLabel(paper.category, isEnglish ? 'en' : 'es')}</span>}
                    {paper.year && <span>{paper.year}</span>}
                  </div>
                  <h2>
                    <PaperLink destination={destination} label={copy.open(paper.title)}>
                      <ScientificText>{paper.title}</ScientificText>
                    </PaperLink>
                  </h2>
                  {paper.authors?.length > 0 && (
                    <p className="public-list-paper-authors">
                      {paper.authors.slice(0, 5).join(', ')}{paper.authors.length > 5 ? ' et al.' : ''}
                    </p>
                  )}
                  {/* Through the same KaTeX pass as the title above, and as
                      every other abstract in the app (the feed card, the
                      explorer, the report). This was the one that rendered
                      raw: a shared list of maths papers showed its readers
                      "$G_{2}$-invariant" where every other screen showed the
                      formula. */}
                  {paper.abstract && (
                    <p className="public-list-paper-abstract">
                      <ScientificText>{paper.abstract}</ScientificText>
                    </p>
                  )}
                  <div className="public-list-paper-footer">
                    {/* "0 citations" on every row is noise, not information. */}
                    {Number.isInteger(paper.citations) && paper.citations > 0 && (
                      <span><Quote size={14} /> {copy.citations(paper.citations)}</span>
                    )}
                    {paper.concepts?.slice(0, 3).map(concept => <span key={concept}>{concept}</span>)}
                  </div>
                </div>
              </article>
            );
          })}
          {publicList.papers.length === 0 && (
            <div className="public-list-empty">
              <span className="public-list-empty-icon" aria-hidden="true"><BookOpen size={20} /></span>
              <p>{copy.empty}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
