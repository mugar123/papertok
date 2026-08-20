import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { FileText, Bookmark, Microscope, FlaskConical, Atom, Dna, Brain, Cpu, Database, Orbit, Network, Activity } from 'lucide-react';
import './LoginPage.css';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';

const FLOATING_ICONS = [FileText, Bookmark, Microscope, FlaskConical, Atom, Dna, Brain, Cpu, Database, Orbit, Network, Activity];

export default function LoginPage() {
  const { signInWithGoogle, signInWithGitHub, error, user, onboardingComplete, loading } = useAuth();
  const { language, isEnglish } = useLanguage();
  const [pendingProvider, setPendingProvider] = useState(null);
  const [collision, setCollision] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { trackEvent } = useAnalyticsConsent();
  const requestedReturnTo = location.state?.returnTo;
  const returnToFromQuery = new URLSearchParams(location.search).get('returnTo');
  const requestedDestination = requestedReturnTo || returnToFromQuery;
  const returnTo = typeof requestedDestination === 'string'
    && requestedDestination.startsWith('/')
    && !requestedDestination.startsWith('//')
    && !['/login', '/onboarding'].includes(requestedDestination.split('?')[0])
    ? requestedDestination
    : '/';

  // Redirect if already authenticated
  useEffect(() => {
    if (!loading && user) {
      if (onboardingComplete) {
        navigate(returnTo, { replace: true });
      } else {
        navigate('/onboarding', { replace: true, state: { returnTo } });
      }
    }
  }, [user, loading, onboardingComplete, navigate, returnTo]);

  const SIGN_IN_METHODS = {
    google: signInWithGoogle,
    github: signInWithGitHub,
  };

  const handleSignIn = async (method) => {
    setPendingProvider(method);
    setCollision(null);
    trackEvent('select_content', { content_type: 'signup_cta', surface: 'login', method });
    try {
      const result = await SIGN_IN_METHODS[method]();
      trackEvent(result?.isNewUser ? 'sign_up' : 'login', { method });
    } catch (signInError) {
      // One account per email address: this address already opens PaperTok
      // through some other door. Which one cannot be named from here — with
      // email enumeration protection on, Firebase will not say — so the copy
      // points at "the method you already use" and the linking lives in
      // settings, where a session exists to link onto.
      if (signInError?.code === 'AUTH_EMAIL_ALREADY_USED') {
        setCollision({ email: signInError.email || '' });
      }
      // Anything else surfaces through the localized error state below.
    } finally {
      setPendingProvider(null);
    }
  };

  const [floatingElements, setFloatingElements] = useState([]);

  useEffect(() => {
    setTimeout(() => setFloatingElements(
      Array.from({ length: 25 }).map((_, i) => {
        const Icon = FLOATING_ICONS[i % FLOATING_ICONS.length];
        const x = Math.floor(Math.random() * 100);
        const y = Math.floor(Math.random() * 100);
        const delay = (Math.random() * 5).toFixed(2);
        const size = Math.floor(Math.random() * 24) + 20; // 20 to 44
        const opacity = (Math.random() * 0.15 + 0.05).toFixed(2); // 0.05 to 0.20
        const duration = (Math.random() * 4 + 8).toFixed(2); // 8s to 12s
        return { id: i, Icon, x, y, delay, size, opacity, duration };
      })
    ), 0);
  }, []);

  return (
    <div className="login-page">
      {/* Animated background */}
      <div className="login-bg">
        <div className="login-bg-orb login-bg-orb--1" />
        <div className="login-bg-orb login-bg-orb--2" />
        <div className="login-bg-orb login-bg-orb--3" />
      </div>

      {/* Floating paper icons */}
      <div className="floating-papers">
        {floatingElements.map((el) => (
          <span
            key={el.id}
            className="floating-paper"
            style={{
              '--delay': `${el.delay}s`,
              '--duration': `${el.duration}s`,
              '--x': `${el.x}%`,
              '--y': `${el.y}%`,
              color: `rgba(255,255,255,${el.opacity})`,
            }}
          >
            <el.Icon size={el.size} />
          </span>
        ))}
      </div>

      {/* Main content */}
      <div className="login-content">
        <div className="login-logo">
          <h1 className="login-wordmark">
            <span className="gradient-text">Paper</span>
            <span className="login-tok">Tok</span>
          </h1>
        </div>

        <p className="login-tagline">
          {isEnglish
            ? <>Discover scientific papers<br />like never before</>
            : <>Descubre papers científicos<br />como nunca antes</>}
        </p>

        <p className="login-description">
          {isEnglish
            ? 'A personalized, TikTok-style feed featuring the latest papers. Swipe, explore, and build your scientific library.'
            : 'Un feed personalizado estilo TikTok con los papers más recientes. Desliza, explora y construye tu biblioteca científica.'}
        </p>

        <div className="login-methods">
          <button
            className={`login-google-btn ${pendingProvider === 'google' ? 'login-google-btn--loading' : ''}`}
            onClick={() => handleSignIn('google')}
            disabled={Boolean(pendingProvider)}
            id="google-sign-in-btn"
          >
            {pendingProvider === 'google' ? (
              <div className="login-spinner" />
            ) : (
              <>
                <svg className="login-google-icon" viewBox="0 0 24 24" width="24" height="24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                <span>{isEnglish ? 'Continue with Google' : 'Continuar con Google'}</span>
              </>
            )}
          </button>

          <button
            className={`login-provider-btn ${pendingProvider === 'github' ? 'login-provider-btn--loading' : ''}`}
            onClick={() => handleSignIn('github')}
            disabled={Boolean(pendingProvider)}
            id="github-sign-in-btn"
          >
            {pendingProvider === 'github' ? (
              <div className="login-spinner login-spinner--onDark" />
            ) : (
              <>
                <svg className="login-provider-icon" viewBox="0 0 16 16" width="22" height="22" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                  />
                </svg>
                <span>{isEnglish ? 'Continue with GitHub' : 'Continuar con GitHub'}</span>
              </>
            )}
          </button>
        </div>

        <button
          type="button"
          className="login-explore-btn"
          onClick={() => {
            trackEvent('guest_demo_start', { entry_point: 'login', language });
            navigate('/', { replace: true });
          }}
        >
          {isEnglish ? 'Explore without an account' : 'Explorar sin crear una cuenta'}
        </button>

        {collision ? (
          <div className="login-collision" role="alert">
            <h2>{isEnglish ? 'That email already has an account' : 'Ese correo ya tiene cuenta'}</h2>
            <p>
              {collision.email
                ? (isEnglish
                  ? <><strong>{collision.email}</strong> already signs in to PaperTok another way. Use the method you already have, and once you are in, connect GitHub from Settings.</>
                  : <><strong>{collision.email}</strong> ya entra en PaperTok por otro método. Usa el que ya tienes y, una vez dentro, conecta GitHub desde Ajustes.</>)
                : (isEnglish
                  ? 'That address already signs in to PaperTok another way. Use the method you already have, and once you are in, connect GitHub from Settings.'
                  : 'Ese correo ya entra en PaperTok por otro método. Usa el que ya tienes y, una vez dentro, conecta GitHub desde Ajustes.')}
            </p>
          </div>
        ) : error && <p className="login-error">{getUiErrorMessage(error, language, 'AUTH_FAILED')}</p>}

        <p className="login-powered">
          Powered by <strong>arXiv</strong>
        </p>
      </div>
    </div>
  );
}
