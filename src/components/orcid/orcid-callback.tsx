import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { orcidCallbackParams } from '../../services/orcid-connection-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import Petri from '../onboarding/petri.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import './orcid-callback.css';

/**
 * Where ORCID returns the browser after its sign-in. The code and state were
 * taken off the address when the app loaded (orcid-connection-service.ts);
 * the Worker checks the state against the one this account asked for, and a
 * connected account goes to My profile. A refusal stays here and says why.
 */
export default function OrcidCallback() {
  const { user, loading, completeOrcidConnection } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failure, setFailure] = useState('');
  const backRef = useRef<HTMLButtonElement>(null);
  // ORCID returns without a code when the person denies access.
  const authorized = Boolean(orcidCallbackParams?.code && orcidCallbackParams.state);
  const stopped = !loading && (!user || !authorized || Boolean(failure));

  useEffect(() => {
    if (loading || !user || !authorized || started.current) return;
    started.current = true;
    void (async () => {
      try {
        await completeOrcidConnection(orcidCallbackParams!.code, orcidCallbackParams!.state);
      } catch (error) {
        setFailure((error as { code?: string }).code || 'ORCID_FAILED');
        return;
      }
      toast.success('ORCID is connected.');
      void navigate('/profile', { replace: true });
    })();
  }, [authorized, completeOrcidConnection, loading, navigate, user]);

  useEffect(() => {
    if (stopped) backRef.current?.focus();
  }, [stopped]);

  const message = !user ? 'Sign in to PaperTok, then connect ORCID again from My profile.'
    : !authorized ? getUiErrorMessage('ORCID_AUTHORIZATION_REFUSED')
      : getUiErrorMessage(failure, 'ORCID_FAILED');

  return (
    <main className="orcid-callback" aria-busy={!stopped || undefined}>
      <EmptyState
        as="h1"
        className="orcid-callback-state"
        aria-live="polite"
        art={loading ? null : <Petri pose={stopped ? 'thinking' : 'reading'} />}
        title={loading ? 'Loading your account…' : stopped ? 'ORCID wasn’t connected.' : 'Connecting ORCID…'}
        actions={stopped ? (
          <Button ref={backRef} onClick={() => { void navigate(user ? '/profile' : '/', { replace: true }); }}>
            {user ? 'Go to My profile' : 'Return to PaperTok'}
          </Button>
        ) : null}
      >
        {stopped ? message : null}
      </EmptyState>
    </main>
  );
}
