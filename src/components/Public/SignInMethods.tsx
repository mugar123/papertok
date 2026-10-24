import { useId } from 'react';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import { Button } from '../ui/button.tsx';
import GoogleMark from './GoogleMark.tsx';
import { GithubMark } from '../ui/GithubMark.tsx';
import { useProviderSignIn } from './useProviderSignIn.ts';
import { CollisionNote, PreparingNote, ProviderSpinner } from './ProviderSignIn.tsx';
import './AuthPrompt.css';

/**
 * The Google and GitHub buttons in the sign-in dialog (AuthPrompt), and what
 * they report back: an address that already signs in another way, or a
 * failure. They count as the `auth_prompt` surface.
 */
export default function SignInMethods() {
  const { pendingProvider, collision, error, preparing, signIn: handleSignIn } = useProviderSignIn('auth_prompt');
  const preparingId = useId();
  return (
    <>
      {/* While preparing, the buttons stay focusable and say why they do
          nothing (useProviderSignIn). */}
      <div className="auth-modal-methods">
        <Button
          variant="outline"
          size="lg"
          className="auth-provider w-full"
          onClick={() => { void handleSignIn('google'); }}
          disabled={preparing}
          focusableWhenDisabled
          aria-describedby={preparing ? preparingId : undefined}
          id="google-sign-in-btn"
        >
          {preparing || pendingProvider === 'google' ? (
            <ProviderSpinner />
          ) : (
            <GoogleMark className="auth-provider-icon" />
          )}
          <span>{'Continue with Google'}</span>
        </Button>

        <Button
          variant="outline"
          size="lg"
          className="auth-provider w-full"
          onClick={() => { void handleSignIn('github'); }}
          disabled={preparing}
          focusableWhenDisabled
          aria-describedby={preparing ? preparingId : undefined}
          id="github-sign-in-btn"
        >
          {preparing || pendingProvider === 'github' ? (
            <ProviderSpinner />
          ) : (
            <GithubMark className="auth-provider-icon" />
          )}
          <span>{'Continue with GitHub'}</span>
        </Button>
        <PreparingNote id={preparingId} preparing={preparing} />
      </div>

      {collision ? (
        <div className="auth-modal-note auth-modal-note--warn" role="alert">
          <CollisionNote email={collision.email} />
        </div>
      ) : error ? (
        <p className="auth-modal-note auth-modal-note--error" role="alert">
          {getUiErrorMessage(error, 'AUTH_FAILED')}
        </p>
      ) : null}
    </>
  );
}
