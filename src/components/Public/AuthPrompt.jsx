import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { Button } from '../ui/button.jsx';
import './AuthPrompt.css';

// The in-context door. It signs the guest in on the spot, which is the whole
// point — someone who tapped "save" on a paper should still be looking at that
// paper afterwards — so it deliberately offers no way out to /login: that page
// exists for the trips that already took the user somewhere else (a direct
// link, a protected route), and those are the only ones that need a `returnTo`.
export default function AuthPrompt({ onClose }) {
  const { signInWithGoogle, signInWithGitHub, error, user } = useAuth();
  const { language, isEnglish } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const prefersReducedMotion = useReducedMotion();
  const dialogRef = useDialogFocus(true, onClose);
  const [pendingProvider, setPendingProvider] = useState(null);
  const [collision, setCollision] = useState(null);

  // Once a session exists the prompt has done its job: routing takes the user on
  // to onboarding or the feed, so the modal steps out of the way.
  useEffect(() => {
    if (user) onClose();
  }, [user, onClose]);

  const SIGN_IN_METHODS = {
    google: signInWithGoogle,
    github: signInWithGitHub,
  };

  const handleSignIn = async (method) => {
    setPendingProvider(method);
    setCollision(null);
    trackEvent('select_content', { content_type: 'signup_cta', surface: 'auth_prompt', method });
    try {
      const result = await SIGN_IN_METHODS[method]();
      trackEvent(result?.isNewUser ? 'sign_up' : 'login', { method });
    } catch (signInError) {
      // One account per email address: this address already opens PaperTok
      // through some other door. Email enumeration protection means Firebase
      // will not name which, so the copy points at "the method you already use".
      if (signInError?.code === 'AUTH_EMAIL_ALREADY_USED') {
        setCollision({ email: signInError.email || '' });
      }
    } finally {
      setPendingProvider(null);
    }
  };

  const busy = Boolean(pendingProvider);

  return (
    <motion.div
      className="auth-modal-backdrop"
      role="presentation"
      initial={prefersReducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.1 : 0.2, ease: 'easeOut' }}
      onClick={onClose}
    >
      <motion.section
        ref={dialogRef}
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        tabIndex={-1}
        initial={prefersReducedMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="auth-modal-close"
          data-dialog-initial-focus
          onClick={onClose}
          aria-label={isEnglish ? 'Close' : 'Cerrar'}
        >
          <X size={16} />
        </Button>

        <div className="auth-modal-brand">
          <span className="auth-modal-mark" aria-hidden="true">P</span>
          <span className="auth-modal-wordmark">Paper<span>Tok</span></span>
        </div>

        <h2 id="auth-modal-title" className="auth-modal-title">
          {isEnglish ? 'Make PaperTok yours' : 'Haz que PaperTok sea tuyo'}
        </h2>
        <p className="auth-modal-lede">
          {isEnglish
            ? 'Like, save and follow research, and train a feed that learns what you read.'
            : 'Da me gusta, guarda y sigue investigación, y entrena un feed que aprende lo que lees.'}
        </p>

        <div className="auth-modal-methods">
          <Button
            variant="outline"
            size="lg"
            className="auth-provider w-full"
            onClick={() => handleSignIn('google')}
            disabled={busy}
            id="google-sign-in-btn"
          >
            {pendingProvider === 'google' ? (
              <span className="auth-spinner" aria-hidden="true" />
            ) : (
              <svg className="auth-provider-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
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
            className="auth-provider w-full"
            onClick={() => handleSignIn('github')}
            disabled={busy}
            id="github-sign-in-btn"
          >
            {pendingProvider === 'github' ? (
              <span className="auth-spinner auth-spinner--on-ink" aria-hidden="true" />
            ) : (
              <svg className="auth-provider-icon" viewBox="0 0 16 16" width="19" height="19" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                />
              </svg>
            )}
            <span>{isEnglish ? 'Continue with GitHub' : 'Continuar con GitHub'}</span>
          </Button>
        </div>

        {collision ? (
          <div className="auth-modal-note auth-modal-note--warn" role="alert">
            {collision.email
              ? (isEnglish
                ? <><strong>{collision.email}</strong> already signs in another way. Use that method, then connect GitHub from Settings.</>
                : <><strong>{collision.email}</strong> ya entra por otro método. Usa ese y luego conecta GitHub desde Ajustes.</>)
              : (isEnglish
                ? 'That address already signs in another way. Use that method, then connect GitHub from Settings.'
                : 'Ese correo ya entra por otro método. Usa ese y luego conecta GitHub desde Ajustes.')}
          </div>
        ) : error ? (
          <p className="auth-modal-note auth-modal-note--error" role="alert">
            {getUiErrorMessage(error, language, 'AUTH_FAILED')}
          </p>
        ) : null}

      </motion.section>
    </motion.div>
  );
}
