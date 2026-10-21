import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext.tsx';
import {
  cancelInstitutionVerification, institutionVerificationLink, pendingInstitutionVerification,
} from '../../services/institutionService.ts';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import Petri from '../Onboarding/Petri.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import InstitutionPill from './InstitutionPill.tsx';
import './Institution.css';

// After these, retrying the same link cannot succeed. Only Firebase's expiry
// code proves the link expired; the others leave several causes open.
const DEAD_LINK_CODES = new Set([
  'auth/expired-action-code', 'auth/invalid-action-code', 'INSTITUTION_TOKEN_INVALID', 'INSTITUTION_VERIFICATION_CANCELED',
]);

export default function InstitutionVerification() {
  const { user, loading, institution, onboardingComplete, completeInstitutionVerification } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [completedUid, setCompletedUid] = useState<string | null>(null);
  const done = Boolean(completedUid && completedUid === user?.uid);
  const [failure, setFailure] = useState('');
  const returnRef = useRef<HTMLButtonElement>(null);
  const pending = loading ? null : pendingInstitutionVerification();
  const canVerify = Boolean(user && pending && institutionVerificationLink);
  const stopped = !loading && !done && !busy && (!canVerify || DEAD_LINK_CODES.has(failure));
  useEffect(() => {
    if (done || (failure && stopped)) returnRef.current?.focus();
  }, [done, failure, stopped]);
  const destination = onboardingComplete ? '/settings/profile' : '/onboarding';

  async function verify() {
    if (busy || !canVerify) return;
    setBusy(true);
    setFailure('');
    try {
      await completeInstitutionVerification(institutionVerificationLink);
      setCompletedUid(user?.uid ?? null);
    } catch (error) {
      setFailure((error as { code?: string } | null)?.code || 'INSTITUTION_LINK_FAILED');
    } finally {
      setBusy(false);
    }
  }

  const expired = failure === 'auth/expired-action-code';
  const retryable = Boolean(failure) && !DEAD_LINK_CODES.has(failure);
  const title = loading ? 'Loading your account…'
    : done ? 'Your university is connected.'
      : !stopped ? 'Verify your university email'
        : expired ? 'This link has expired.'
          : retryable ? 'Your university wasn’t connected.'
            : 'This link can’t be used here.';
  const reason = expired ? 'Verification links only work for a limited time. Nothing on your account has changed.'
    : retryable ? getUiErrorMessage(failure, 'INSTITUTION_LINK_FAILED')
      : failure === 'auth/invalid-action-code' || failure === 'INSTITUTION_TOKEN_INVALID'
        ? 'It may have been used already, or copied incompletely from the email. Nothing on your account has changed.'
        : 'It may have expired, been used already, been replaced by a newer link, or been opened in another browser or account. Nothing on your account has changed.';
  const nextStep = !user ? 'Sign in to PaperTok, then request a new link from your university settings.'
    : onboardingComplete ? 'Request a new link from your university settings, then open it in this browser.'
      : 'Request a new link from the university step of setup, then open it in this browser.';

  return (
    <main
      className={`institution-verification${done ? ' is-connected' : stopped ? ' is-stopped' : ''}`}
      aria-busy={busy || undefined}
    >
      {/* One live region for every state, so each result replaces announced content. */}
      <EmptyState
        as="h1"
        className="institution-verification-state"
        aria-live="polite"
        art={loading ? null : stopped ? <Petri pose="thinking" /> : (
          // Petri changes into her university look only once the server has confirmed the link.
          <>
            <Petri pose="reading" level={done ? 'university' : 'beginner'} />
            {done && <InstitutionPill institution={institution} />}
          </>
        )}
        title={title}
        actions={loading ? null : (
          <>
            {retryable && !stopped && (
              <p className="institution-link-feedback is-error" role="alert">{getUiErrorMessage(failure, 'INSTITUTION_LINK_FAILED')}</p>
            )}
            {!done && !stopped && canVerify && (
              <Button onClick={() => { void verify(); }} disabled={busy} focusableWhenDisabled>
                {busy ? 'Verifying…' : 'Verify and link university'}
              </Button>
            )}
            <Button ref={returnRef} variant={done || stopped ? 'default' : 'outline'} disabled={busy} focusableWhenDisabled onClick={() => {
              cancelInstitutionVerification();
              navigate(destination, { replace: true });
            }}>
              {done ? 'Continue to PaperTok'
                : !stopped ? 'Cancel verification'
                  : !user ? 'Return to PaperTok'
                    : onboardingComplete ? 'Open university settings' : 'Back to setup'}
              {done && <ArrowRight size={16} aria-hidden="true" />}
            </Button>
          </>
        )}
      >
        {loading ? null : done ? (
          <><strong>{institution?.name || 'Your university'}</strong> is now linked to your PaperTok account. Your saved papers and preferences stay as they were.</>
        ) : stopped ? `${reason} ${nextStep}` : (
          `Link ${pending?.email} to the PaperTok account ${user?.email || user?.displayName}. Your saved papers and preferences stay with this account.`
        )}
      </EmptyState>
    </main>
  );
}
