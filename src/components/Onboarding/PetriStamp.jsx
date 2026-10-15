import { BODY } from './PetriFrame.jsx';
import './PetriStamp.css';

// Petri, the mascot, as a rubber stamp: on the corner of the university
// screen's paper (LibraryPreview) and of the guest welcome's digest envelope
// (DigestPreview): a double ring in the rose accent with her,
// idle and smiling, inside. Decoration: the previews it sits on are hidden from
// assistive tech already.
export default function PetriStamp() {
  return (
    <svg className="onboarding-petri-stamp" viewBox="0 0 60 60" aria-hidden="true" focusable="false">
      <g fill="none" stroke="var(--accent-rose)" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="30" cy="30" r="27" strokeWidth="2.2" />
        <circle cx="30" cy="30" r="23" strokeWidth="1" strokeDasharray="2 2.4" />
      </g>
      {/* The idle pose from petri.html, scaled into the ring. */}
      <g transform="translate(-1.5 -6.2) scale(0.42)" strokeLinecap="round" strokeLinejoin="round">
        <path d={BODY} fill="var(--brand-yellow)" stroke="var(--accent-rose)" strokeWidth="5" />
        <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" stroke="var(--accent-rose)" strokeWidth="5" />
        <circle cx="70" cy="90" r="5" fill="var(--text-on-brand)" />
        <circle cx="90" cy="90" r="5" fill="var(--text-on-brand)" />
        <path d="M72 100q8 7 16 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="4.5" />
      </g>
    </svg>
  );
}
