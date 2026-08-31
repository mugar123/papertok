import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { Button } from '../ui/button.jsx';
import './LoginPage.css';

// The page and the AuthPrompt modal are the same act on two surfaces: the modal
// is the in-context shortcut (a guest who taps "save" should not lose the paper
// they were reading), this page is the destination of a direct /login link and
// of every guest bounced off a protected route. Only this one carries a
// `returnTo`, because only this one took the user away from where they were.
export default function LoginPage() {
  const { signInWithGoogle, signInWithGitHub, error, user, onboardingComplete, loading, profileLoadError } = useAuth();
  const { language, isEnglish } = useLanguage();
  const [pendingProvider, setPendingProvider] = useState(null);
  const [collision, setCollision] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { trackEvent } = useAnalyticsConsent();
  const requestedReturnTo = location.state?.returnTo;
  const returnToFromQuery = new URLSearchParams(location.search).get('returnTo');
  const requestedDestination = requestedReturnTo || returnToFromQuery;
  // Only an in-app absolute path is honoured: `//evil.com` is a protocol-relative
  // URL the browser would follow off-site, and bouncing back to /login or
  // /onboarding would trap the user in a loop.
  const returnTo = typeof requestedDestination === 'string'
    && requestedDestination.startsWith('/')
    && !requestedDestination.startsWith('//')
    && !['/login', '/onboarding'].includes(requestedDestination.split('?')[0])
    ? requestedDestination
    : '/';

  // Redirect if already authenticated. A session that still owes onboarding goes
  // through it first, carrying the destination so the trip ends where it began.
  useEffect(() => {
    if (!loading && user) {
      if (profileLoadError) return;
      if (onboardingComplete) {
        navigate(returnTo, { replace: true });
      } else {
        navigate('/onboarding', { replace: true, state: { returnTo } });
      }
    }
  }, [user, loading, onboardingComplete, profileLoadError, navigate, returnTo]);

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

  const busy = Boolean(pendingProvider);

  return (
    <main className="login-page">
      {/* Graph paper. Two nodes, not one: the wrapper clips and fades, the
          plane inside it is what drifts. All of the motion is CSS on those two
          elements — no loop, no canvas, nothing on the main thread. */}
      <div className="login-grid" aria-hidden="true">
        <div className="login-grid-plane" />
      </div>

      <section className="login-sheet">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">P</span>
          <span className="login-wordmark">Paper<span>Tok</span></span>
        </div>

        <span className="mono-label login-eyebrow">
          {isEnglish ? 'Sign in' : 'Entrar'}
        </span>

        {/* The space before the break is load-bearing: without it the accessible
            name of the heading runs the two halves together ("paperslike"),
            because the <br> joins the text nodes with nothing between them. It
            collapses at the end of the visual line, so nothing moves. */}
        <h1 className="login-title">
          {isEnglish
            ? <>Discover scientific papers <br />like never before</>
            : <>Descubre papers científicos <br />como nunca antes</>}
        </h1>

        <p className="login-lede">
          {isEnglish
            ? 'A personalized, TikTok-style feed featuring the latest papers. Swipe, explore, and build your scientific library.'
            : 'Un feed personalizado estilo TikTok con los papers más recientes. Desliza, explora y construye tu biblioteca científica.'}
        </p>

        <div className="login-methods">
          <Button
            variant="outline"
            size="lg"
            className="login-provider w-full"
            onClick={() => handleSignIn('google')}
            disabled={busy}
            id="login-google-btn"
          >
            {pendingProvider === 'google' ? (
              <span className="login-spinner" aria-hidden="true" />
            ) : (
              <svg className="login-provider-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            <span>{isEnglish ? 'Continue with Google' : 'Continuar con Google'}</span>
          </Button>

          <Button
            variant="default"
            size="lg"
            className="login-provider w-full"
            onClick={() => handleSignIn('github')}
            disabled={busy}
            id="login-github-btn"
          >
            {pendingProvider === 'github' ? (
              <span className="login-spinner login-spinner--on-ink" aria-hidden="true" />
            ) : (
              <svg className="login-provider-icon" viewBox="0 0 16 16" width="19" height="19" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                />
              </svg>
            )}
            <span>{isEnglish ? 'Continue with GitHub' : 'Continuar con GitHub'}</span>
          </Button>
        </div>

        <div className="login-alt" aria-hidden="true">
          <span>{isEnglish ? 'or' : 'o bien'}</span>
        </div>

        <Button
          variant="ghost"
          size="default"
          className="login-explore w-full"
          onClick={() => {
            trackEvent('guest_demo_start', { entry_point: 'login', language });
            navigate('/', { replace: true });
          }}
        >
          {isEnglish ? 'Explore without an account' : 'Explorar sin crear una cuenta'}
        </Button>

        {collision ? (
          <div className="login-note login-note--warn" role="alert">
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
        ) : error ? (
          <p className="login-note login-note--error" role="alert">
            {getUiErrorMessage(error, language, 'AUTH_FAILED')}
          </p>
        ) : null}

        <p className="login-powered">
          Powered by <strong>arXiv</strong>
        </p>
      </section>
    </main>
  );
}
