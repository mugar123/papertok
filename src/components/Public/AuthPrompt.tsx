import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext.tsx';
import { authPromptCopy, normalizeAuthReason } from './authPromptCopy.ts';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import SignInMethods from './SignInMethods.tsx';
import { Button } from '../ui/button.tsx';
import Petri from '../Onboarding/Petri.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
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
export default function AuthPrompt({ onClose, reason = 'default' }: { onClose: () => void; reason?: unknown }) {
  const { user } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  // What opened the door decides what it says (authPromptCopy.js).
  const copy = authPromptCopy(reason);
  const [open, setOpen] = useState(true);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Once a session exists the prompt has done its job: routing takes the user on
  // to onboarding or the feed, so the modal steps out of the way. Derived, not
  // an effect: the session appearing is itself the close.
  const isOpen = open && !user;
  const viewTracked = useRef(false);
  useEffect(() => {
    if (!isOpen || viewTracked.current) return;
    viewTracked.current = true;
    void trackEvent('auth_prompt_view', { surface: 'auth_prompt', reason: normalizeAuthReason(reason) });
  }, [isOpen, reason, trackEvent]);


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

        <Petri pose="key" className="auth-modal-petri" />

        <DialogTitle className="auth-modal-title">
          {copy.title}
        </DialogTitle>
        <DialogDescription className="auth-modal-lede">
          {copy.lede}
        </DialogDescription>

        <SignInMethods />
      </DialogContent>
    </Dialog>
  );
}
