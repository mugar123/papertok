import { useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext.jsx';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { authPromptCopy } from './authPromptCopy.js';
import { Button } from '../ui/button.jsx';
import GoogleMark from './GoogleMark.jsx';
import { COLLISION_NOTE, useProviderSignIn } from './useProviderSignIn.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.jsx';
import './AuthPrompt.css';

// The one door. It signs the guest in on the spot, which is the whole point —
// someone who tapped "save" on a paper should still be looking at that paper
// afterwards. There is no sign-in page any more: a guest bounced off a
// protected route lands on the feed with this open (App.jsx), and the route
// they asked for waits there until the session exists.
//
// App.jsx mounts this only while it is wanted (`{authPromptOpen && <AuthPrompt/>}`),
// so the dialog opens on mount and owns its own `open` flag: closing — the X,
// Escape, the scrim, or a session appearing — flips it, Base UI plays the
// leave, and only then `onOpenChangeComplete(false)` tells the parent to
// unmount. That is the one place `onClose` is called, so it reaches App once.
export default function AuthPrompt({ onClose, reason = 'default' }) {
  const { user } = useAuth();
  // What opened the door decides what it says (authPromptCopy.js).
  const copy = authPromptCopy(reason);
  const [open, setOpen] = useState(true);
  const { pendingProvider, collision, error, signIn: handleSignIn } = useProviderSignIn('auth_prompt');
  const closeButtonRef = useRef(null);

  // Once a session exists the prompt has done its job: routing takes the user on
  // to onboarding or the feed, so the modal steps out of the way. Derived, not
  // an effect: the session appearing is itself the close.
  const isOpen = open && !user;


  return (
    <Dialog
      open={isOpen}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(); }}
      modal
    >
      <DialogContent
        className="auth-modal"
        overlayClassName="auth-modal-backdrop"
        showClose={false}
        // Focus lands on the close control, as it always has here: the
        // reader hears the title and the lede, and no provider is preselected.
        initialFocus={closeButtonRef}
      >
        <DialogClose
          ref={closeButtonRef}
          render={<Button variant="ghost" size="icon-sm" className="auth-modal-close" />}
          aria-label={'Close'}
        >
          <X size={16} />
        </DialogClose>

        <div className="auth-modal-brand">
          <span className="auth-modal-mark" aria-hidden="true">P</span>
          <span className="auth-modal-wordmark">Paper<span>Tok</span></span>
        </div>

        <DialogTitle className="auth-modal-title">
          {copy.title}
        </DialogTitle>
        <DialogDescription className="auth-modal-lede">
          {copy.lede}
        </DialogDescription>

        <div className="auth-modal-methods">
          <Button
            variant="outline"
            size="lg"
            className="auth-provider w-full"
            onClick={() => handleSignIn('google')}
            id="google-sign-in-btn"
          >
            {pendingProvider === 'google' ? (
              <span className="auth-spinner" aria-hidden="true" />
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
              <span className="auth-spinner" aria-hidden="true" />
            ) : (
              <svg className="auth-provider-icon" viewBox="0 0 16 16" width="19" height="19" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                />
              </svg>
            )}
            <span>{'Continue with GitHub'}</span>
          </Button>
        </div>

        {collision ? (
          <div className="auth-modal-note auth-modal-note--warn" role="alert">
            {collision.email ? <strong>{collision.email}</strong> : 'That address'} {COLLISION_NOTE}
          </div>
        ) : error ? (
          <p className="auth-modal-note auth-modal-note--error" role="alert">
            {getUiErrorMessage(error, 'AUTH_FAILED')}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
