import type { PropsWithChildren, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { peekAuthReturn } from '../../utils/auth-return.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import Petri from '../onboarding/petri.tsx';
import BootScreen from './boot-screen.tsx';
import { BootScreenProvider } from './boot-screen-context.ts';

export default function ProtectedRoute({ children, requireOnboarding = true, holdBootScreen = false }: PropsWithChildren<{
  requireOnboarding?: boolean;
  /** Keep the loader over the page a reload opened on until it calls `useReleaseBootScreen`. */
  holdBootScreen?: boolean;
}>) {
  const location = useLocation();
  const {
    user,
    loading,
    onboardingComplete,
    profileLoadError,
    retryProfileLoad,
  } = useAuth();

  // One `state` object per destination, not per render. `<Navigate>` navigates
  // again whenever its `state` prop changes, so a fresh literal re-issued the
  // redirect on every auth update — three times per bounce — and a route
  // already leaving under AnimatePresence kept sending the new account to the
  // onboarding "to return to /feed", over the destination it had just reached.
  const requestedPath = `${location.pathname}${location.search}`;
  const signInState = useMemo(() => ({ authRequired: true, returnTo: requestedPath }), [requestedPath]);
  // A new account can be sent to the onboarding from a route other than the
  // one it asked for, so "return to this route" would be the wrong one. The
  // destination the sign-in is carrying wins, read once at mount: taking it
  // later would change the state and re-issue the redirect.
  const [carriedDestination] = useState(peekAuthReturn);
  const onboardingReturnTo = carriedDestination ?? requestedPath;
  const onboardingState = useMemo(() => ({ returnTo: onboardingReturnTo }), [onboardingReturnTo]);
  // A route that booted under the loader mounts its page under the same loader
  // element, so the mascot does not rise a second time. The loader stays until
  // the page releases it, which a page whose chunk is still downloading cannot.
  const [bootRoute] = useState(() => holdBootScreen && loading);
  const [bootScreenUp, setBootScreenUp] = useState(bootRoute);
  const releaseBootScreen = useCallback(() => setBootScreenUp(false), []);
  const bootFrame = (page: ReactNode) => (
    <>
      {page}
      {bootScreenUp && <BootScreen />}
    </>
  );

  if (loading) {
    // The feed route brings its own wait. FeedContainer lays an atom veil over
    // the container from its first paint and lifts it as the first card
    // composes, so the gate hands the route over now and that veil is the
    // boot screen too: one atom from the first frame to the papers. The gate
    // used to draw an atom of its own here and swap it for the veil the frame
    // the session resolved — a new SVG with the electrons back at the start
    // of their orbits, a different copy, the atom a step higher — and, since
    // `AnimatePresence initial={false}` (app.tsx) keeps PageTransition from
    // entering on the first render, nothing between the two. Nothing under
    // the veil can act before the session is known: the feed only loads once
    // it has preferences and a profile (FeedContext's loadPapers).
    if (location.pathname === '/feed') {
      return children;
    }

    return bootScreenUp ? bootFrame(null) : <BootScreen />;
  }

  if (!user) {
    // There is no sign-in page and no guest feed: a visitor lands on the
    // onboarding with the sign-in dialog open (app.tsx reads `authRequired`).
    // The route they asked for travels with them, and App sends them there
    // once a session exists, instead of dropping everyone on the feed. The
    // feed is the home address, so a visitor arriving there gets the welcome
    // without a dialog over it.
    return <Navigate to="/onboarding" replace state={location.pathname === '/feed' ? undefined : signInState} />;
  }

  if (profileLoadError) {
    return (
      <div className="loading-screen">
        <Petri pose="flask" className="petri-loader loading-atom" />
        <h2 className="loading-error-title">{'Your profile could not be loaded'}</h2>
        <p className="loading-text">
          {getUiErrorMessage(profileLoadError, 'PROFILE_LOAD_FAILED')}
        </p>
        <button className="loading-retry" onClick={retryProfileLoad}>{'Try again'}</button>
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
    return <Navigate to="/onboarding" replace state={onboardingState} />;
  }

  if (bootRoute) {
    return bootFrame(
      <BootScreenProvider value={releaseBootScreen}>{children}</BootScreenProvider>,
    );
  }

  return children;
}
