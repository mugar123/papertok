import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.tsx';
import {
  cancelInstitutionVerification, institutionVerificationLink, pendingInstitutionVerification,
} from '../../services/institutionService.ts';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import { Button } from '../ui/button.tsx';
import InstitutionPill from './InstitutionPill.tsx';
import './Institution.css';

export default function InstitutionVerification() {
  const { user, loading, institution, onboardingComplete, completeInstitutionVerification } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const returnRef = useRef<HTMLButtonElement>(null);
  const pending = loading ? null : pendingInstitutionVerification();
  const canVerify = Boolean(user && pending && institutionVerificationLink);
  useEffect(() => {
    if (done || (error && !canVerify)) returnRef.current?.focus();
  }, [done, error, canVerify]);
  const destination = onboardingComplete ? '/settings/profile' : '/onboarding';

  async function verify() {
    if (busy || !canVerify) return;
    setBusy(true);
    setError('');
    try {
      await completeInstitutionVerification(institutionVerificationLink);
      setDone(true);
    } catch (failure) {
      setError(getUiErrorMessage(failure, 'INSTITUTION_LINK_FAILED'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="institution-verification" aria-labelledby="institution-verification-title" aria-busy={busy || undefined}>
      <h1 id="institution-verification-title">{done ? 'University linked' : 'Verify your university email'}</h1>
      {loading ? <p role="status">Loading your account…</p> : done ? (
        <div role="status">
          {institution && <InstitutionPill institution={institution} />}
          <p>Your university is linked to your existing PaperTok account.</p>
        </div>
      ) : canVerify ? (
        <p>Link your university to the PaperTok account {user?.email || user?.displayName}. Your saved papers and preferences stay with this account.</p>
      ) : error ? null : (
        <p role="alert">{getUiErrorMessage('INSTITUTION_VERIFICATION_CANCELED')}</p>
      )}
      {error && <p className="institution-link-feedback is-error" role="alert">{error} If verification cannot continue, request a new link from your university settings.</p>}
      <div className="institution-verification-actions">
        {!done && canVerify && <Button onClick={() => { void verify(); }} disabled={busy} focusableWhenDisabled>{busy ? 'Verifying…' : 'Verify and link university'}</Button>}
        {!loading && <Button ref={returnRef} variant="outline" disabled={busy} focusableWhenDisabled onClick={() => {
          cancelInstitutionVerification();
          navigate(destination, { replace: true });
        }}>{done ? 'Continue' : canVerify ? 'Cancel verification' : 'Return to PaperTok'}</Button>}
      </div>
    </section>
  );
}
