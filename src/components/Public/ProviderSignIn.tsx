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

// Why a Google or GitHub button is disabled until its window can open inside
// the press (usePopupReady). Hidden, so it is read as the button's
// description and not as page text. Settings and the institution link use it too.
export function PreparingNote({ id }: { id: string }) {
  return <span id={id} hidden>Preparing sign-in…</span>;
}
