import { useId } from 'react';
import './Petri.css';

// Petri, the mascot, experimenting (obradither/landing/petri.html,
// `petri-flask`): on its dish, one pseudopod holding up a flask, eyes on it
// and a curious little "o". The topics screen's prop, drawn like the
// greeting's (PetriWelcome): body and arm outlined in their own yellow, the
// dish and the face in ink, the flask outlined in the face's ink
// (--text-on-brand) in both themes and its glass paper on both. It stands where the screen's kicker was, so it carries the kicker
// as its name (`label`).
export default function PetriFlask({ label, className }) {
  const hatch = useId();
  const liquid = useId();
  return (
    // The greeting's crop, so both screens' Petri share a size and an axis.
    <svg viewBox="14 22 128 124" role="img" aria-label={label} className={className}>
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="1.4" height="4" fill="currentColor" />
        </pattern>
        {/* The flask's glass is paper at night too, so what is inside it is
            drawn in the card's ink (--text-on-brand), not the page's. */}
        <pattern id={liquid} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="1.4" height="4" fill="var(--text-on-brand)" />
        </pattern>
      </defs>
      <g stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <ellipse cx="78" cy="128" rx="62" ry="15" fill="var(--bg-primary)" />
        <ellipse cx="78" cy="124" rx="54" ry="10" fill={`url(#${hatch})`} strokeWidth="1.6" />
        <g className="onboarding-petri-body">
          <path d="M104 100q10-6 10-32" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />
          <path d="M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" />
          <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" strokeWidth="2" />
          <circle cx="74" cy="86" r="3.4" fill="var(--text-on-brand)" stroke="none" />
          <circle cx="92" cy="86" r="3.4" fill="var(--text-on-brand)" stroke="none" />
          <path d="M86 77q5-3 10 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
          <ellipse cx="82" cy="100" rx="2.4" ry="3" fill="var(--text-on-brand)" stroke="none" />
          <path className="petri-prop-line" data-flat="" style={{ '--prop-fill': 'var(--bg-figure-plate)' }} d="M123 29v11l-11 24a3 3 0 0 0 2.7 4.3h22.6a3 3 0 0 0 2.7-4.3L129 40V29Z" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" />
          <path d="M116.1 55H135.9L140 64a3 3 0 0 1-2.7 4.3H114.7A3 3 0 0 1 112 64Z" fill={`url(#${liquid})`} stroke="none" />
          <path d="M116.1 55H135.9" stroke="var(--text-on-brand)" strokeWidth="1.6" />
          <path d="M121 29h10" strokeWidth="3" stroke="var(--text-on-brand)" />
          <circle cx="122" cy="49" r="1.8" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" strokeWidth="1.3" />
          <circle cx="128" cy="44" r="1.3" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" strokeWidth="1.2" />
          <circle cx="127" cy="21" r="1.8" fill="var(--bg-figure-plate)" strokeWidth="1.3" stroke="var(--text-on-brand)" />
          {/* The hand grips the flask, so it sits over the glass. */}
          <circle cx="114" cy="66" r="5" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" strokeWidth="2.2" />
        </g>
      </g>
    </svg>
  );
}
