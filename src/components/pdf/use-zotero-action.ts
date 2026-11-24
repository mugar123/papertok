import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { toastError } from '../ui/toast.ts';
import type { Paper } from '../../models/paper.ts';
import type { PaperMenuAction } from '../feed/paper-menu.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { usePageRestored } from '../../hooks/use-page-restored.ts';
import { connectZotero, sendToZotero, zoteroCitation, zoteroStatus, type ZoteroStatus } from '../../services/zotero-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
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
  const key = uid && paper.id ? `${uid}:${paper.id}` : '';
  const [state, setState] = useState<{ key: string; status: ZoteroStatus | null; busy: boolean }>({ key, status: null, busy: false });
  if (state.key !== key) setState({ key, status: null, busy: false });
  const { status, busy } = state.key === key ? state : { status: null, busy: false };
  const setStatus = useCallback((status: ZoteroStatus) => setState(current => current.key === key ? { ...current, status } : current), [key]);
  const setBusy = useCallback((busy: boolean) => setState(current => current.key === key ? { ...current, busy } : current), [key]);
  const scope = useMemo(() => ({ active: Boolean(key), working: false, busyUntil: 0 }), [key]);
  const asked = useRef('');
  useEffect(() => {
    scope.active = Boolean(key);
    return () => { scope.active = false; };
  }, [scope, key]);

  useEffect(() => {
    if (!wanted || !key || asked.current === key) return undefined;
    asked.current = key;
    let live = true;
    zoteroStatus(paper.id).then(next => { if (live) setStatus(next); }, () => {});
    return () => { live = false; };
  }, [key, wanted, paper.id, setStatus]);

  usePageRestored(() => {
    scope.working = false;
    setBusy(false);
  });

  if (!key || !uid) return null;

  async function connect() {
    if (!scope.active) return;
    scope.working = true;
    setBusy(true);
    try {
      await connectZotero(uid!, zoteroCitation(paper));
    } catch (error) {
      if (!scope.active) return;
      scope.working = false;
      setBusy(false);
      toastError(getUiErrorMessage(error, 'ZOTERO_FAILED'));
    }
  }

  function busyMessage() {
    const seconds = Math.max(1, Math.ceil((scope.busyUntil - Date.now()) / 1000));
    return `Zotero is busy right now. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }

  /** A retry is offered once: a send that fails again only says why. */
  async function send(retry = false) {
    if (!scope.active || scope.working) return;
    if (Date.now() < scope.busyUntil) { toastError(busyMessage()); return; }
    if (status?.connected === false) { await connect(); return; }
    scope.working = true;
    setBusy(true);
    const sending = toast.loading('Sending to Zotero…');
    try {
      const { sentAt, highlights } = await sendToZotero(zoteroCitation(paper));
      if (!scope.active) { toast.dismiss(sending); return; }
      setStatus({ connected: true, username: status?.username ?? null, sentAt });
      void trackEvent('zotero_send', { result: 'sent' });
      toast.success(highlights ? `Sent to Zotero with ${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}.` : 'Sent to Zotero.', { id: sending });
    } catch (error) {
      toast.dismiss(sending);
      if (!scope.active) return;
      void trackEvent('zotero_send', { result: 'failed' });
      const code = (error as { code?: string }).code;
      if (code === 'ZOTERO_NOT_CONNECTED') {
        setStatus({ connected: false, username: null, sentAt: null });
        toastError(getUiErrorMessage(code), { action: { label: 'Reconnect Zotero', onClick: () => { void connect(); } } });
      } else if (code === 'ZOTERO_RATE_LIMITED') {
        scope.busyUntil = Date.now() + ((error as { retryAfter?: number | null }).retryAfter ?? 60) * 1000;
        toastError(busyMessage());
      } else {
        toastError(getUiErrorMessage(error, 'ZOTERO_FAILED'), retry ? {} : { action: { label: 'Try again', onClick: () => { void send(true); } } });
      }
    } finally {
      if (scope.active) {
        scope.working = false;
        setBusy(false);
      }
    }
  }

  const [label, hint] = status?.connected === false
    ? ['Connect Zotero', 'Then this paper goes to your library']
    : status?.sentAt
      ? ['Send to Zotero again', `Last sent ${sentDate.format(new Date(status.sentAt))}`]
      : ['Send to Zotero', 'Adds it to your library, with your highlights'];
  return { id: 'zotero', label, hint, Icon: ZoteroMark, onSelect: () => { void send(); }, busy, sent: Boolean(status?.sentAt) };
}
