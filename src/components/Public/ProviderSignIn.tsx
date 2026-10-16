import './ProviderSignIn.css';

// The parts both places with the Google and GitHub buttons draw (the sign-in
// modal and the welcome's disclosure), next to useProviderSignIn.js.

// One account per email address: the address already signs in some other way.
export function CollisionNote({ email }) {
  return <>{email ? <strong>{email}</strong> : 'That address'} already signs in another way. Use that method, then connect the other from Settings.</>;
}

// Stands in for the provider's mark while its window is open.
export function ProviderSpinner() {
  return <span className="auth-spinner" aria-hidden="true" />;
}
