import { useRef } from 'react';
import { ShieldCheck } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { PRIVACY_POLICY_CHANGE } from '../../legal/privacyPolicy.ts';
import './privacy-notice.css';

const COPY = {
  title: 'Privacy policy updated',
  // The bullets are a selection (privacyPolicy.ts); the policy says the rest.
  summary: 'The main changes:',
  policy: 'Read the policy',
  newTab: ' (opens in a new tab)',
  done: 'Got it',
  hide: 'Hide for now',
  hideDetail: ' (shows again next visit)',
  close: 'Close',
};

/**
 * The privacy policy change, told in a modal dialog over the feed
 * (NudgeHost decides when). Got it is remembered for the account; Hide for now,
 * Escape, the close button and a press outside put it away for this visit only
 * (`onHide`).
 *
 * Focus starts on the title, not on the first control (the link under the
 * summary), so a screen reader starts reading at the title, and a dialog that
 * scrolls opens at its top. The summary is never cut: on a short screen or with
 * large text the dialog scrolls (privacy-notice.css).
 */
export default function PrivacyNotice({ open, onAcknowledge, onHide }: { open: boolean; onAcknowledge: () => void; onHide: () => void }) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onHide(); }}>
      <DialogContent className="privacy-notice" closeLabel={COPY.close} initialFocus={titleRef}>
        <DialogTitle ref={titleRef} tabIndex={-1} className="privacy-notice-title">
          <ShieldCheck size={20} aria-hidden="true" />
          {COPY.title}
        </DialogTitle>
        <DialogDescription render={<div />} className="privacy-notice-summary">
          <p>{COPY.summary}</p>
          <ul>
            {PRIVACY_POLICY_CHANGE.map(change => <li key={change}>{change}</li>)}
          </ul>
        </DialogDescription>
        <p className="privacy-notice-policy">
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">
            {COPY.policy}
            <span className="visually-hidden">{COPY.newTab}</span>
          </a>
        </p>
        <div className="privacy-notice-actions">
          <Button size="sm" onClick={onAcknowledge}>{COPY.done}</Button>
          <Button size="sm" variant="outline" onClick={onHide}>
            {COPY.hide}
            <span className="visually-hidden">{COPY.hideDetail}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
