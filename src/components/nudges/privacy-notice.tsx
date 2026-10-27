import { useEffect, useId, useRef, useState } from 'react';
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
// Where the feed caps the notice's height, only the copy scrolls: the actions
// stay in view. While it scrolls the copy is a Tab stop, so the arrow keys can
// scroll it (the feed leaves keys inside its notice slot alone); while it fits
// it is not, and the keyboard goes straight to the link and the actions.
export default function PrivacyNotice({ onAcknowledge, onHide }: { onAcknowledge: () => void; onHide: () => void }) {
  const titleId = useId();
  const copyRef = useRef<HTMLDivElement | null>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const copy = copyRef.current;
    if (!copy) return undefined;
    const measure = () => setScrolls(copy.scrollHeight > copy.clientHeight + 1);
    measure();
    // The box changes with the viewport; its children change with the text size.
    const observer = new ResizeObserver(measure);
    observer.observe(copy);
    for (const child of copy.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="privacy-notice" aria-labelledby={titleId}>
      <span className="privacy-notice-icon" aria-hidden="true"><ShieldCheck size={19} /></span>
      <div
        ref={copyRef}
        className="privacy-notice-copy"
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? 'group' : undefined}
        aria-labelledby={scrolls ? titleId : undefined}
      >
        <h2 id={titleId}>{COPY.title}</h2>
        <p className="privacy-notice-summary">{PRIVACY_POLICY_CHANGE}</p>
        <p>
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
