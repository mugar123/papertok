import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { completeZotero, sendToZotero, takePendingZoteroSend, zoteroCallbackParams } from '../../services/zotero-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import Petri from '../onboarding/petri.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import './zotero-callback.css';

export default function ZoteroCallback() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failure, setFailure] = useState('');
  const [returnTo, setReturnTo] = useState('/settings/profile');
  const backRef = useRef<HTMLButtonElement>(null);
  const authorized = Boolean(zoteroCallbackParams?.oauthToken && zoteroCallbackParams.oauthVerifier);
  const stopped = !loading && (!user || !authorized || Boolean(failure));

  useEffect(() => {
    if (loading || !user || !authorized || started.current) return;
    started.current = true;
    const pending = takePendingZoteroSend(user.uid);
    void (async () => {
      try {
        await completeZotero(zoteroCallbackParams!.oauthToken, zoteroCallbackParams!.oauthVerifier);
      } catch (error) {
        if (pending) setReturnTo(pending.returnTo);
        setFailure((error as { code?: string }).code || 'ZOTERO_FAILED');
        return;
      }
      if (!pending) {
        toast.success('Zotero is connected.');
        void navigate('/settings/profile', { replace: true });
        return;
      }
      try {
        await sendToZotero(pending.citation);
        toast.success('Sent to Zotero.');
      } catch (error) {
        toast.error(`Zotero is connected, but the paper was not sent. ${getUiErrorMessage(error, 'ZOTERO_FAILED')}`);
      }
      void navigate(pending.returnTo, { replace: true });
    })();
  }, [authorized, loading, navigate, user]);

  useEffect(() => {
    if (stopped) backRef.current?.focus();
  }, [stopped]);

  const message = !user ? 'Sign in to PaperTok, then connect Zotero again from a paper.'
    : !authorized ? getUiErrorMessage('ZOTERO_AUTHORIZATION_REFUSED')
      : getUiErrorMessage(failure, 'ZOTERO_FAILED');

  return (
    <main className="zotero-callback" aria-busy={!stopped || undefined}>
      <EmptyState
        as="h1"
        className="zotero-callback-state"
        aria-live="polite"
        art={loading ? null : <Petri pose={stopped ? 'thinking' : 'reading'} />}
        title={loading ? 'Loading your account…' : stopped ? 'Zotero wasn’t connected.' : 'Connecting Zotero…'}
        actions={stopped ? (
          <Button ref={backRef} onClick={() => { void navigate(user ? returnTo : '/', { replace: true }); }}>
            Return to PaperTok
          </Button>
        ) : null}
      >
        {stopped ? message : null}
      </EmptyState>
    </main>
  );
}
