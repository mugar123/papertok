import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { getUiErrorMessage } from '../../utils/errorMessages';
import AnimatedAtom from '../Feed/AnimatedAtom';
import '../Feed/FeedContainer.css';

function InitialFeedLoading() {
  return (
    <div
      className="feed-empty feed-empty--initial-loading"
      role="status"
      aria-label="PaperTok"
      aria-busy="true"
    >
      <div className="atom-loader" aria-hidden="true">
        <AnimatedAtom size={80} strokeWidth={1} className="atom-loader-icon" />
      </div>
      <h2>PaperTok</h2>
    </div>
  );
}

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
    if (location.pathname === '/') {
      return <InitialFeedLoading />;
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
            filter: drop-shadow(0 0 15px var(--accent-primary));
            animation: pulseAtom 2s infinite alternate ease-in-out;
          }
          @keyframes pulseAtom {
            0% { transform: scale(0.95); filter: drop-shadow(0 0 10px var(--accent-primary)); }
            100% { transform: scale(1.05); filter: drop-shadow(0 0 25px var(--accent-primary)); }
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
    // No login page any more: a guest who reaches a gated route lands on the
    // feed, where the sign-in modal is one tap away.
    return <Navigate to="/" replace />;
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
