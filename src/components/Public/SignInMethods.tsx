import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import { Button } from '../ui/button.tsx';
import GoogleMark from './GoogleMark.tsx';
import { GithubMark } from '../ui/GithubMark.tsx';
import { useProviderSignIn } from './useProviderSignIn.ts';
import { CollisionNote, ProviderSpinner } from './ProviderSignIn.tsx';
import './AuthPrompt.css';

/**
 * The Google and GitHub buttons in the sign-in dialog (AuthPrompt), and what
 * they report back: an address that already signs in another way, or a
 * failure. They count as the `auth_prompt` surface.
 */
export default function SignInMethods() {
  const { pendingProvider, collision, error, signIn: handleSignIn } = useProviderSignIn('auth_prompt');
  return (
    <>
      <div className="auth-modal-methods">
        <Button
          variant="outline"
          size="lg"
          className="auth-provider w-full"
          onClick={() => handleSignIn('google')}
          id="google-sign-in-btn"
        >
          {pendingProvider === 'google' ? (
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
          onClick={() => handleSignIn('github')}
          id="github-sign-in-btn"
        >
          {pendingProvider === 'github' ? (
            <ProviderSpinner />
          ) : (
            <GithubMark className="auth-provider-icon" />
          )}
          <span>{'Continue with GitHub'}</span>
        </Button>
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
