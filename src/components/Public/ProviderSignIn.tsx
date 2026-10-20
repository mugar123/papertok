import { useState } from 'react';
import './ProviderSignIn.css';

// The parts both places with the Google and GitHub buttons draw (the sign-in
// modal and the welcome's disclosure), next to useProviderSignIn.js.

// One account per email address: the address already signs in some other way.
export function CollisionNote({ email }: { email?: string }) {
  return <>{email ? <strong>{email}</strong> : 'That address'} already signs in another way. Use that method, then connect the other from Settings.</>;
}

// Stands in for the provider's mark while its window is open, and while it
// could not yet open from the press.
export function ProviderSpinner() {
  return <span className="auth-spinner" aria-hidden="true" />;
}

// Under buttons that are disabled until their window can open inside the
// press (usePopupReady): "Preparing sign-in…", in a polite status that also
// describes them. When the wait ends a screen reader hears "Sign-in ready."
// and the line stays, empty, so the buttons do not move as they turn usable.
// The welcome passes `keepLine={false}`: its provider stack is positioned by
// its top edge, so the buttons stay put without the line, which would only
// push the sign-in error under it further down.
// Mounted with nothing to wait for, it takes no room and says nothing.
// Settings and the institution link use it too.
export function PreparingNote({ id, preparing, keepLine = true }: { id: string; preparing: boolean; keepLine?: boolean }) {
  // A readiness only ever turns ready (PopupReadiness), so only a note that
  // mounted preparing has a wait to report the end of.
  const [waited] = useState(preparing);
  return (
    <p id={id} role="status" className={waited && (preparing || keepLine) ? 'provider-preparing' : 'sr-only'}>
      {preparing ? 'Preparing sign-in…' : waited && <span className="sr-only">Sign-in ready.</span>}
    </p>
  );
}
