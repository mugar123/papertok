import type { PopupReadinessState } from '../../services/popup-redirect-resolver.ts';
import { useState } from 'react';
import useRetryFocus from '../../hooks/use-retry-focus.ts';
import { Button } from '../ui/button.tsx';
import './provider-sign-in.css';

// The parts both places with the Google and GitHub buttons draw (the sign-in
// modal and the welcome's disclosure), next to use-provider-sign-in.ts.

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
// press (usePopupReady), in a polite status that also describes them:
// "Preparing sign-in…" while the load runs, and "Sign-in could not load." with
// Try again once it failed or ran too long. When the wait ends a screen reader
// hears "Sign-in ready." and the line stays, empty, so the buttons do not move
// as they turn usable. The welcome passes `keepLine={false}`: its provider
// stack is positioned by its top edge, so the buttons stay put without the
// line, which would only push the sign-in error under it further down.
// Mounted with nothing to wait for, it takes no room and says nothing.
// Settings and the institution link use it too.
export function PreparingNote({ id, state, onRetry, keepLine = true }: { id: string; state: PopupReadinessState; onRetry: () => void; keepLine?: boolean }) {
  // Only a note that has shown a wait has the end of one to report.
  const [waited, setWaited] = useState(state !== 'ready');
  if (state !== 'ready' && !waited) setWaited(true);
  const describedControl = () => [...document.querySelectorAll<HTMLElement>('[aria-describedby]')]
    .find(element => element.getAttribute('aria-describedby')?.split(' ').includes(id)) ?? null;
  // Try again leaves as the load restarts, or when a slow load ends by itself,
  // so the focus goes to the control this note describes: first when the
  // button is pressed, and by useRetryFocus when it leaves on its own.
  const retryFocus = useRetryFocus(state === 'failed', describedControl);
  const retry = () => {
    describedControl()?.focus();
    onRetry();
  };
  return (
    <p className={waited && (state !== 'ready' || keepLine) ? 'provider-preparing' : 'sr-only'}>
      <span id={id} role="status">
        {state === 'preparing' && 'Preparing sign-in…'}
        {state === 'failed' && 'Sign-in could not load.'}
        {state === 'ready' && waited && <span className="sr-only">Sign-in ready.</span>}
      </span>
      {state === 'failed' && (
        <>
          {' '}
          <Button variant="outline" size="sm" onClick={retry} {...retryFocus}>Try again</Button>
        </>
      )}
    </p>
  );
}
