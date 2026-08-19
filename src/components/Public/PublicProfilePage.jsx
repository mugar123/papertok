import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BadgeCheck, RefreshCw, UserRound } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import { readUserProfileByHandle } from '../../services/userProfileService.js';
import { getPublicListPath, getPublicProfilePath } from '../../utils/publicNavigation.js';
import { getIcon } from '../../utils/icons.js';
import { normalizeHandle } from '../../utils/userHandle.js';
import './PublicProfilePage.css';

/**
 * The public half of an account, at /public/user/{handle}.
 *
 * Two reads, both public: the handle reservation, then the profile. The pinned
 * list cards are denormalized into the profile document, so rendering them
 * costs nothing extra and never touches `publicLists`. Following a card is
 * what loads the list itself.
 */
export default function PublicProfilePage({ handle: handleProp, onAuthRequired }) {
  const params = useParams();
  const handle = normalizeHandle(handleProp || params.handle);
  const { isEnglish } = useLanguage();
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState('loading');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    readUserProfileByHandle(handle)
      .then(result => {
        if (!active) return;
        setProfile(result);
        setStatus(result ? 'ready' : 'not-found');
      })
      .catch(error => {
        console.error('Error loading public profile:', error);
        if (!active) return;
        setStatus(error?.code === 'USER_PROFILES_UNSUPPORTED_IN_DEMO' ? 'unsupported' : 'error');
      });
    return () => { active = false; };
  }, [handle, reloadToken]);

  const metadata = useMemo(() => {
    const fallbackDescription = {
      en: 'A public researcher profile on PaperTok.',
      es: 'Un perfil público de investigación en PaperTok.',
    };
    return {
      route: getPublicProfilePath(handle),
      title: profile ? {
        en: `${profile.displayName} (@${profile.handle}) | PaperTok`,
        es: `${profile.displayName} (@${profile.handle}) | PaperTok`,
      } : {
        en: 'Public profile | PaperTok',
        es: 'Perfil público | PaperTok',
      },
      description: profile?.bio || fallbackDescription,
      imageAlt: {
        en: 'A public researcher profile on PaperTok',
        es: 'Un perfil público de investigación en PaperTok',
      },
      noIndex: status !== 'ready',
    };
  }, [handle, profile, status]);
  usePublicPageMetadata(metadata);

  const copy = isEnglish ? {
    brand: 'PaperTok',
    publicProfile: 'Public profile',
    loading: 'Opening profile...',
    notFoundTitle: 'This profile is not available',
    notFoundBody: 'The handle may have changed or the link may be incomplete.',
    errorTitle: 'The profile could not be loaded',
    errorBody: 'Check your connection and try again.',
    unsupportedTitle: 'Public profiles are unavailable in demo mode',
    unsupportedBody: 'Open this link in the full PaperTok app.',
    retry: 'Try again',
    verified: 'Verified researcher',
    pinnedLists: 'Pinned reading lists',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    open: title => `Open ${title}`,
    empty: 'This profile has not pinned any reading lists yet.',
    authCta: user ? 'Go to my lists' : 'Sign in to build your own',
  } : {
    brand: 'PaperTok',
    publicProfile: 'Perfil público',
    loading: 'Abriendo perfil...',
    notFoundTitle: 'Este perfil no está disponible',
    notFoundBody: 'Puede que el handle haya cambiado o que el enlace esté incompleto.',
    errorTitle: 'No se pudo cargar el perfil',
    errorBody: 'Comprueba tu conexión e inténtalo de nuevo.',
    unsupportedTitle: 'Los perfiles públicos no están disponibles en el modo demo',
    unsupportedBody: 'Abre este enlace en la aplicación completa de PaperTok.',
    retry: 'Reintentar',
    verified: 'Investigador verificado',
    pinnedLists: 'Listas de lectura fijadas',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    open: title => `Abrir ${title}`,
    empty: 'Este perfil todavía no ha fijado ninguna lista de lectura.',
    authCta: user ? 'Ir a mis listas' : 'Inicia sesión para crear el tuyo',
  };

  if (status !== 'ready') {
    const state = {
      loading: { title: copy.loading, body: '' },
      'not-found': { title: copy.notFoundTitle, body: copy.notFoundBody },
      error: { title: copy.errorTitle, body: copy.errorBody },
      unsupported: { title: copy.unsupportedTitle, body: copy.unsupportedBody },
    }[status];

    return (
      <main className="public-profile-page public-profile-page--state">
        <div className="public-profile-shell">
          <p className="public-profile-brand">{copy.brand}</p>
          <h1>{state.title}</h1>
          {state.body && <p className="public-profile-state-body">{state.body}</p>}
          {status === 'error' && (
            <button
              type="button"
              className="public-profile-retry"
              onClick={() => setReloadToken(token => token + 1)}
            >
              <RefreshCw size={16} /> {copy.retry}
            </button>
          )}
        </div>
      </main>
    );
  }

  const pinnedLists = profile.pinnedLists || [];

  return (
    <main className="public-profile-page">
      <div className="public-profile-shell">
        <p className="public-profile-brand">{copy.brand} · {copy.publicProfile}</p>

        <header className="public-profile-header">
          <div className="public-profile-avatar">
            {profile.photo
              ? <img src={profile.photo} alt="" />
              : <span className="public-profile-avatar-fallback"><UserRound size={32} /></span>}
          </div>
          <div className="public-profile-identity">
            <h1>
              {profile.displayName}
              {profile.verified && (
                <span className="public-profile-verified" title={copy.verified}>
                  <BadgeCheck size={20} aria-label={copy.verified} />
                </span>
              )}
            </h1>
            <p className="public-profile-handle">@{profile.handle}</p>
            {profile.bio && <p className="public-profile-bio">{profile.bio}</p>}
          </div>
        </header>

        <section className="public-profile-lists" aria-labelledby="public-profile-lists-title">
          <h2 id="public-profile-lists-title">{copy.pinnedLists}</h2>
          {pinnedLists.length === 0 ? (
            <p className="public-profile-empty">{copy.empty}</p>
          ) : (
            <ul className="public-profile-list-grid">
              {pinnedLists.map(list => {
                // `emoji` holds a lucide icon name, not a literal emoji.
                const Icon = getIcon(list.emoji);
                return (
                <li key={list.shareId}>
                  <Link
                    className="public-profile-list-card"
                    to={getPublicListPath(list.shareId)}
                    aria-label={copy.open(list.title)}
                  >
                    <span className="public-profile-list-emoji" aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <span className="public-profile-list-copy">
                      <span className="public-profile-list-title">{list.title}</span>
                      <span className="public-profile-list-count">
                        {copy.papers(list.paperCount ?? 0)}
                      </span>
                    </span>
                  </Link>
                </li>
                );
              })}
            </ul>
          )}
        </section>

        <footer className="public-profile-footer">
          {user ? (
            <Link className="public-profile-auth-cta" to="/lists">{copy.authCta}</Link>
          ) : (
            <button
              type="button"
              className="public-profile-auth-cta"
              onClick={onAuthRequired}
            >
              {copy.authCta}
            </button>
          )}
        </footer>
      </div>
    </main>
  );
}
