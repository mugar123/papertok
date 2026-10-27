import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import usePopupReady from '../../hooks/use-popup-ready.ts';
import { SIGN_IN_PROVIDERS, signInEvents, signInFailure } from '../../services/auth-identity-service.ts';
import { popupReadiness } from '../../services/firebase.ts';

/**
 * Google and GitHub sign-in on the spot, for every place that offers the two
 * buttons: the sign-in modal (AuthPrompt) and the welcome's own disclosure.
 * `surface` names the place for analytics. Returns the provider in flight, the
 * one-account-per-email collision when it happens, the press handler, and
 * `readiness`: until the window can open inside the press (usePopupReady),
 * both buttons are disabled, and `retry` loads again after a failure.
 *
 * A press is never refused while a window is open: Firebase notices a closed
 * popup only seconds later (and behind some opener policies, never), so a
 * reader who closed it would be left with buttons that do nothing. Pressing
 * again opens a fresh window, Firebase cancels the old one, and only the
 * latest attempt decides what the buttons show.
 *
 * A browser that blocks the window sends the sign-in through this tab instead
 * (auth-identity-service.ts). Its press never settles here: the page leaves,
 * and AuthContext reports the outcome on the page it comes back to.
 */

export function useProviderSignIn(surface: string) {
  const { signInWithGoogle, signInWithGitHub, error } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  const [pendingProvider, setPendingProvider] = useState<'google' | 'github' | null>(null);
  const [collision, setCollision] = useState<{ email: string } | null>(null);
  const latest = useRef(0);
  const readiness = usePopupReady(popupReadiness);

  // Back from the provider's page, Safari can show this page from its
  // back/forward cache, as it was left: with the press that went through this
  // tab still pending, and its spinner still turning.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      latest.current += 1;
      setPendingProvider(null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const signIn = async (method: 'google' | 'github') => {
    const attempt = latest.current + 1;
    latest.current = attempt;
    setPendingProvider(method);
    setCollision(null);
    void trackEvent('select_content', { content_type: 'signup_cta', surface, method });
    try {
      const result = await (method === 'google' ? signInWithGoogle : signInWithGitHub)(surface);
      for (const [name, params] of signInEvents(SIGN_IN_PROVIDERS[method], surface, { result: 'success', isNewUser: Boolean(result?.isNewUser) })) {
        void trackEvent(name, params);
      }
    } catch (signInError) {
      for (const [name, params] of signInEvents(SIGN_IN_PROVIDERS[method], surface, signInFailure(signInError))) {
        void trackEvent(name, params);
      }
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

  // A redirect that came back refused leaves only AuthContext's error: the
  // address it carried stays with the provider's page.
  const shownCollision = collision ?? (error === 'AUTH_EMAIL_ALREADY_USED' ? { email: '' } : null);
  return { pendingProvider, collision: shownCollision, error, readiness, retry: () => popupReadiness.retry(), signIn };
}
