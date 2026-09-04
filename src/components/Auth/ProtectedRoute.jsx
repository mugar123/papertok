import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { getUiErrorMessage } from '../../utils/errorMessages';
import AnimatedAtom from '../Feed/AnimatedAtom';

export default function ProtectedRoute({ children, requireOnboarding = true }) {
  const { language, isEnglish } = useLanguage();
  const location = useLocation();
  const {
    user,
    loading,
    onboardingComplete,
    profileLoadError,
    retryProfileLoad,
  } = useAuth();

  if (loading) {
    // The feed route brings its own wait. FeedContainer lays an atom veil over
    // the container from its first paint and lifts it as the first card
    // composes, so the gate hands the route over now and that veil is the
    // boot screen too: one atom from the first frame to the papers. The gate
    // used to draw an atom of its own here and swap it for the veil the frame
    // the session resolved — a new SVG with the electrons back at the start
    // of their orbits, a different copy, the atom a step higher — and, since
    // `AnimatePresence initial={false}` (App.jsx) keeps PageTransition from
    // entering on the first render, nothing between the two. Nothing under
    // the veil can act before the session is known: the feed only loads once
    // it has preferences and a profile (FeedContext's loadPapers).
    if (location.pathname === '/') {
      return children;
    }

    return (
      <div className="loading-screen">
        <AnimatedAtom size={80} strokeWidth={1} className="loading-atom" />
        <p className="loading-text" aria-hidden="true">PaperTok</p>
        <style>{`
          .loading-screen {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            min-height: 100dvh;
            background: var(--bg-primary);
            gap: var(--space-4);
          }
          .loading-atom {
            color: var(--accent-primary);
            /* Fixed now, not animated: a filter is not a compositor property, so
               sweeping its blur radius every frame repainted the auth-loading
               screen for as long as the guard was up. The pulse below reaches
               for the same breathing glow with transform/opacity instead, which
               the compositor can animate without ever repainting this element. */
            filter: drop-shadow(0 0 15px var(--accent-primary));
            animation: pulseAtom 2s infinite alternate ease-in-out;
          }
          @keyframes pulseAtom {
            0% { transform: scale(0.95); opacity: 0.6; }
            100% { transform: scale(1.05); opacity: 1; }
          }
          .loading-text {
            color: var(--text-secondary);
            font-size: var(--fs-sm);
          }
          @media (prefers-reduced-motion: reduce) {
            .loading-atom {
              animation: none;
            }
          }
        `}</style>
      </div>
    );
  }

  if (!user) {
    // The route the guest asked for travels with them: the login page reads it
    // back out of `location.state` and lands them there once a session exists,
    // instead of dropping everyone on the feed.
    return <Navigate to="/login" replace state={{ returnTo: `${location.pathname}${location.search}` }} />;
  }

  if (profileLoadError) {
    return (
      <div className="loading-screen">
        <AnimatedAtom size={64} strokeWidth={1} className="loading-atom" />
        <h2 className="loading-error-title">{isEnglish ? 'Your profile could not be loaded' : 'No se pudo cargar tu perfil'}</h2>
        <p className="loading-text">
          {getUiErrorMessage(profileLoadError, language, 'PROFILE_LOAD_FAILED')}
        </p>
        <button className="loading-retry" onClick={retryProfileLoad}>{isEnglish ? 'Try again' : 'Reintentar'}</button>
        <style>{`
          .loading-screen {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            min-height: 100dvh;
            padding: 24px;
            background: var(--bg-primary);
            gap: var(--space-4);
            text-align: center;
          }
          .loading-atom {
            color: var(--accent-primary);
            filter: drop-shadow(0 0 15px var(--accent-primary));
          }
          .loading-text {
            max-width: 520px;
            margin: 0;
            color: var(--text-secondary);
            font-size: var(--fs-sm);
          }
          .loading-error-title {
            margin: 0;
            color: var(--text-primary);
            font-size: 22px;
            letter-spacing: 0;
          }
          .loading-retry {
            min-height: 44px;
            padding: 0 22px;
            border: 1px solid rgba(139, 92, 246, 0.5);
            border-radius: 7px;
            background: rgba(139, 92, 246, 0.14);
            color: var(--text-primary);
            font: inherit;
            font-weight: 700;
            cursor: pointer;
          }
          .loading-retry:hover {
            background: rgba(139, 92, 246, 0.24);
          }
        `}</style>
      </div>
    );
  }

  if (requireOnboarding && !onboardingComplete) {
    return <Navigate to="/onboarding" replace state={{ returnTo: `${location.pathname}${location.search}` }} />;
  }

  return children;
}
