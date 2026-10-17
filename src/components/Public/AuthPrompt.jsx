import { useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext.jsx';
import { authPromptCopy } from './authPromptCopy.js';
import SignInMethods from './SignInMethods.jsx';
import { Button } from '../ui/button.jsx';
import Petri from '../Onboarding/Petri.jsx';
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
