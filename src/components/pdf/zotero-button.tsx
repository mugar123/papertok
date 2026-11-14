import { useEffect, useRef, useState } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { toast } from 'sonner';
import type { Paper } from '../../models/paper.ts';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { connectZotero, sendToZotero, zoteroCitation, zoteroStatus, type ZoteroStatus } from '../../services/zotero-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { Button } from '../ui/button.tsx';

/** A Z drawn on Phosphor's 256 grid with its regular stroke, so it sits among the page's icons. */
export function ZoteroMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M64 56h128L64 200h128" />
    </svg>
  );
}

const sentDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** Keyed by the paper and the account in the viewer, so each starts unchecked. */
export default function ZoteroButton({ paper, uid }: { paper: Paper; uid: string }) {
  const { trackEvent } = useAnalyticsConsent();
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // A toast's Try again holds an older render's `busy`; this one is current.
  const working = useRef(false);

  useEffect(() => {
    let live = true;
    // An unknown status leaves the button usable: the send itself says whether Zotero is connected.
    zoteroStatus(paper.id).then(next => { if (live) setStatus(next); }, () => {});
    return () => { live = false; };
  }, [paper.id]);

  async function connect() {
    working.current = true;
    setBusy(true);
    try {
      await connectZotero(uid, zoteroCitation(paper));
    } catch (error) {
      working.current = false;
      setBusy(false);
      toast.error(getUiErrorMessage(error, 'ZOTERO_FAILED'));
    }
  }

  async function send() {
    if (working.current) return;
    if (status?.connected === false) { await connect(); return; }
    working.current = true;
    setBusy(true);
    try {
      const { sentAt, highlights } = await sendToZotero(zoteroCitation(paper));
      setStatus({ connected: true, username: status?.username ?? null, sentAt });
      void trackEvent('zotero_send', { result: 'sent' });
      toast.success(highlights ? `Sent to Zotero with ${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}.` : 'Sent to Zotero.');
    } catch (error) {
      void trackEvent('zotero_send', { result: 'failed' });
      const code = (error as { code?: string }).code;
      if (code === 'ZOTERO_NOT_CONNECTED') {
        setStatus({ connected: false, username: null, sentAt: null });
        toast.error(getUiErrorMessage(code), { action: { label: 'Reconnect Zotero', onClick: () => { void connect(); } } });
      } else {
        toast.error(getUiErrorMessage(error, 'ZOTERO_FAILED'), { action: { label: 'Try again', onClick: () => { void send(); } } });
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const label = status?.connected === false ? 'Connect Zotero and send this paper'
    : status?.sentAt ? `Send to Zotero again (last sent ${sentDate.format(new Date(status.sentAt))})`
      : 'Send to Zotero';

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => { void send(); }}
      disabled={busy}
      focusableWhenDisabled
      aria-busy={busy || undefined}
      aria-label={label}
      title={label}
    >
      {busy
        ? <CircleNotch size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <ZoteroMark size={18} />}
    </Button>
  );
}
