import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '../ui/toast.ts';
import type { Paper } from '../../models/paper.ts';
import type { PaperMenuAction } from '../feed/paper-menu.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { usePageRestored } from '../../hooks/use-page-restored.ts';
import { connectZotero, sendToZotero, zoteroCitation, zoteroStatus, type ZoteroStatus } from '../../services/zotero-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { zoteroAnswer } from '../../utils/profile-session-caches.ts';
import { auth } from '../../services/firebase.ts';
import { ZoteroMark } from './zotero-mark.tsx';

const sentDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** The action, plus what a button needs to draw it: a send under way, and whether it was sent before. */
export type ZoteroAction = PaperMenuAction & { busy: boolean; sent: boolean };

/**
 * "Send to Zotero" for a signed-in reader: an entry of a card's options, or the
 * reader's button. The account's Zotero status is asked for only once `wanted`
 * (a card's menu open, or the button shown), so a feed of cards does not ask
 * once per card; an unknown status still sends, and the send itself says
 * whether Zotero is connected.
 */
export function useZoteroAction(paper: Paper, uid: string | null | undefined, wanted: boolean): ZoteroAction | null {
  const { trackEvent } = useAnalyticsConsent();
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef('');
  // A toast's Try again holds an older render's state; this one is current.
  const working = useRef(false);
  // When Zotero said it may be asked again, after it answered busy.
  const busyUntil = useRef(0);
  const key = uid && paper.id ? `${uid}:${paper.id}` : '';

  useEffect(() => {
    if (!wanted || !key || asked.current === key) return undefined;
    asked.current = key;
    let live = true;
    zoteroStatus(paper.id).then(next => { if (live) setStatus(next); }, () => {});
    return () => { live = false; };
  }, [key, wanted, paper.id]);

  usePageRestored(() => {
    working.current = false;
    setBusy(false);
  });

  if (!key || !uid) return null;

  async function connect() {
    working.current = true;
    setBusy(true);
    try {
      await connectZotero(uid!, zoteroCitation(paper));
    } catch (error) {
      working.current = false;
      setBusy(false);
      toastError(getUiErrorMessage(error, 'ZOTERO_FAILED'));
    }
  }

  function busyMessage() {
    const seconds = Math.max(1, Math.ceil((busyUntil.current - Date.now()) / 1000));
    return `Zotero is busy right now. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }

  /** A retry is offered once: a send that fails again only says why. */
  async function send(retry = false) {
    if (working.current) return;
    if (Date.now() < busyUntil.current) { toastError(busyMessage()); return; }
    if (status?.connected === false) { await connect(); return; }
    working.current = true;
    setBusy(true);
    const sending = toast.loading('Sending to Zotero…');
    // A toast's Try again can outlive the account, and the Worker answers for whoever is
    // signed in: Settings records the answer only if this account asked and is still here.
    const recordSettings = auth.currentUser?.uid === uid ? zoteroAnswer.startChange(uid!) : null;
    try {
      const { sentAt, highlights } = await sendToZotero(zoteroCitation(paper));
      setStatus({ connected: true, username: status?.username ?? null, sentAt });
      void trackEvent('zotero_send', { result: 'sent' });
      toast.success(highlights ? `Sent to Zotero with ${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}.` : 'Sent to Zotero.', { id: sending });
    } catch (error) {
      toast.dismiss(sending);
      void trackEvent('zotero_send', { result: 'failed' });
      const code = (error as { code?: string }).code;
      if (code === 'ZOTERO_NOT_CONNECTED') {
        const disconnected = { connected: false, username: null, sentAt: null };
        setStatus(disconnected);
        // Settings must not keep showing a connection Zotero has just refused.
        if (recordSettings && auth.currentUser?.uid === uid) recordSettings(disconnected);
        toastError(getUiErrorMessage(code), { action: { label: 'Reconnect Zotero', onClick: () => { void connect(); } } });
      } else if (code === 'ZOTERO_RATE_LIMITED') {
        busyUntil.current = Date.now() + ((error as { retryAfter?: number | null }).retryAfter ?? 60) * 1000;
        toastError(busyMessage());
      } else {
        toastError(getUiErrorMessage(error, 'ZOTERO_FAILED'), retry ? {} : { action: { label: 'Try again', onClick: () => { void send(true); } } });
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const [label, hint] = status?.connected === false
    ? ['Connect Zotero', 'Then this paper goes to your library']
    : status?.sentAt
      ? ['Send to Zotero again', `Last sent ${sentDate.format(new Date(status.sentAt))}`]
      : ['Send to Zotero', 'Adds it to your library, with your highlights'];
  return { id: 'zotero', label, hint, Icon: ZoteroMark, onSelect: () => { void send(); }, busy, sent: Boolean(status?.sentAt) };
}
