import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { useAuth } from '../../context/auth-context.tsx';
import { authPromptCopy, authPromptViewParams } from './auth-prompt-copy.ts';
import { useAnalyticsConsent } from '../../context/analytics-context.tsx';
import SignInMethods from './sign-in-methods.tsx';
import { Button } from '../ui/button.tsx';
import Petri from '../onboarding/petri.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import './auth-prompt.css';

// The one door. It signs the guest in on the spot, which is the whole point —
// someone who tapped "save" on a paper should still be looking at that paper
// afterwards. There is no sign-in page any more: a guest bounced off a
// protected route lands on the onboarding with this open (app.tsx), and the
// route they asked for waits there until the session exists. The welcome's
// last step opens it too: there is no feed without an account.
//
// app.tsx mounts this only while it is wanted (`{authPromptOpen && <AuthPrompt/>}`),
// so the dialog opens on mount and owns its own `open` flag: closing — the X,
// Escape, the scrim, or a session appearing — flips it, Base UI plays the
// leave, and only then `onOpenChangeComplete(false)` tells the parent to
// unmount. That is the one place `onClose` is called, so it reaches App once.
// `restored` marks the dialog a redirect sign-in returned without a session
// reopens: the reader's own open already counted a prompt view.
export default function AuthPrompt({ onClose, reason = 'default', restored = false }: { onClose: () => void; reason?: unknown; restored?: boolean }) {
  const { user } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  // What opened the door decides what it says (auth-prompt-copy.ts).
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
    const params = authPromptViewParams(reason, restored);
    if (params) void trackEvent('auth_prompt_view', params);
  }, [isOpen, reason, restored, trackEvent]);


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
