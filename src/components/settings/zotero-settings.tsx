import { useEffect, useState } from 'react';
import { LinkBreak, LinkSimple } from '@phosphor-icons/react';
import { ZoteroMark } from '../pdf/zotero-button.tsx';
import { toast } from 'sonner';
import { connectZotero, disconnectZotero, zoteroStatus, type ZoteroStatus } from '../../services/zotero-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { toastError } from '../ui/toast.ts';
import { Button } from '../ui/button.tsx';

/** Keyed by the account in its parent, so a new account starts from an unchecked state. */
export default function ZoteroSettings({ uid }: { uid: string }) {
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    zoteroStatus().then(next => { if (live) setStatus(next); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  async function act() {
    setBusy(true);
    try {
      if (status?.connected) {
        setStatus(await disconnectZotero().then(() => ({ connected: false, username: null, sentAt: null })));
        toast.success('Zotero is disconnected.');
        setBusy(false);
      } else {
        await connectZotero(uid, null);
      }
    } catch (error) {
      setBusy(false);
      toastError(getUiErrorMessage(error, 'ZOTERO_FAILED'));
    }
  }

  const description = failed ? 'The Zotero connection could not be checked. You can still connect it.'
    : !status ? 'Checking your Zotero connection…'
      : status.connected ? `Connected${status.username ? ` as ${status.username}` : ''}. Papers you send while reading go to your personal library.`
        : 'Send the papers you read, with your highlights, to your Zotero library.';

  return (
    <section className="settings-section" aria-labelledby="settings-zotero-heading">
      <div className="settings-section-heading">
        <h2 id="settings-zotero-heading">Zotero</h2>
        <p aria-live="polite">{description}</p>
      </div>
      <div className="settings-list">
        <div className="settings-row settings-row-side">
          <div className="settings-row-content">
            <h3 className="settings-method-name"><ZoteroMark size={16} />Zotero</h3>
          </div>
          {(status || failed) && (
            <Button
              variant="outline"
              size="sm"
              className="settings-row-action"
              onClick={() => { void act(); }}
              disabled={busy}
              focusableWhenDisabled
              aria-label={status?.connected ? 'Disconnect Zotero' : 'Connect Zotero'}
            >
              {status?.connected ? <LinkBreak size={15} aria-hidden="true" /> : <LinkSimple size={15} aria-hidden="true" />}
              {status?.connected ? 'Disconnect' : 'Connect'}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
