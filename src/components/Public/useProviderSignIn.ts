import { useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';

/**
 * Google and GitHub sign-in on the spot, for every place that offers the two
 * buttons: the sign-in modal (AuthPrompt) and the welcome's own disclosure.
 * `surface` names the place for analytics. Returns the provider in flight, the
 * one-account-per-email collision when it happens, and the press handler.
 *
 * A press is never refused while a window is open: Firebase notices a closed
 * popup only seconds later (and behind some opener policies, never), so a
 * reader who closed it would be left with buttons that do nothing. Pressing
 * again opens a fresh window, Firebase cancels the old one, and only the
 * latest attempt decides what the buttons show.
 */

export function useProviderSignIn(surface: string) {
  const { signInWithGoogle, signInWithGitHub, error } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  const [pendingProvider, setPendingProvider] = useState<'google' | 'github' | null>(null);
  const [collision, setCollision] = useState<{ email: string } | null>(null);
  const latest = useRef(0);

  const signIn = async (method: 'google' | 'github') => {
    const attempt = latest.current + 1;
    latest.current = attempt;
    setPendingProvider(method);
    setCollision(null);
    trackEvent('select_content', { content_type: 'signup_cta', surface, method });
    try {
      const result = await (method === 'google' ? signInWithGoogle : signInWithGitHub)();
      trackEvent('auth_result', { method, surface, result: 'success' });
      trackEvent(result?.isNewUser ? 'sign_up' : 'login', { method });
    } catch (signInError) {
      const code = (signInError as { code?: string } | null)?.code || 'other';
      trackEvent('auth_result', {
        method, surface,
        result: code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' ? 'cancelled' : 'error',
        error_code: code,
      });
      // One account per email address: this address already opens PaperTok
      // through some other door. Email enumeration protection means Firebase
      // will not name which, so the copy points at "the method you already use".
      if ((signInError as { code?: string } | null)?.code === 'AUTH_EMAIL_ALREADY_USED' && latest.current === attempt) {
        setCollision({ email: (signInError as { email?: string }).email || '' });
      }
    } finally {
      if (latest.current === attempt) setPendingProvider(null);
    }
  };

  return { pendingProvider, collision, error, signIn };
}
