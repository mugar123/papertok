import { useId } from 'react';
import { ShieldCheck } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { PRIVACY_POLICY_CHANGE } from '../../legal/privacyPolicy.ts';
import { PRIVACY_NOTICE_COPY as COPY } from './use-visit-notice.ts';
import './privacy-notice.css';

// The privacy policy change, told in a row of the feed page above the cards
// (FeedContainer's `notice`), not in a panel over them: in the page's flow it
// covers nothing, so no focused control can be hidden under it (WCAG 2.4.11),
// and it is reached by Tab between the navbar and the first card. It is never
// focused for the reader and traps nothing. Got it is remembered for the account;
// Hide for now puts it away for this visit.
//
// The region is a Tab stop of its own: where the feed caps its height it
// scrolls, and the arrow keys scroll it only while it has focus (the feed leaves
// keys inside its notice slot alone).
export default function PrivacyNotice({ onAcknowledge, onHide }: { onAcknowledge: () => void; onHide: () => void }) {
  const titleId = useId();
  return (
    <section className="privacy-notice" aria-labelledby={titleId} tabIndex={0}>
      <span className="privacy-notice-icon" aria-hidden="true"><ShieldCheck size={19} /></span>
      <div className="privacy-notice-copy">
        <h2 id={titleId}>{COPY.title}</h2>
        <p>
          {PRIVACY_POLICY_CHANGE}{' '}
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">
            {COPY.policy}
            <span className="visually-hidden">{COPY.newTab}</span>
          </a>
        </p>
      </div>
      <div className="privacy-notice-actions">
        <Button size="sm" onClick={onAcknowledge}>{COPY.done}</Button>
        <Button size="sm" variant="outline" onClick={onHide}>
          {COPY.hide}
          <span className="visually-hidden">{COPY.hideDetail}</span>
        </Button>
      </div>
    </section>
  );
}
