import { useId } from 'react';

// Petri, the mascot, thinking (obradither/landing/petri.html,
// `petri-thinking`), in a happier mood: no hands, eyes up, one brow raised,
// a smile and a question mark over her head. The about screen's prop,
// for "say a little about yourself", drawn like the greeting's
// (PetriWelcome): body outlined in its own yellow, the dish, the cilia and
// the question mark in ink. It stands where the screen's kicker was, so it
// carries the kicker as its name (`label`).
export default function PetriThinking({ label, className }) {
  const hatch = useId();
  return (
    // The greeting's crop, so every screen's Petri shares a size and an axis.
    <svg viewBox="14 22 128 124" role="img" aria-label={label} className={className}>
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="1.4" height="4" fill="currentColor" />
        </pattern>
      </defs>
      <g stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <ellipse cx="78" cy="128" rx="62" ry="15" fill="var(--bg-primary)" />
        <ellipse cx="78" cy="124" rx="54" ry="10" fill={`url(#${hatch})`} strokeWidth="1.6" />
        <g className="onboarding-petri-body">
          <path d="M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" />
          <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" strokeWidth="2" />
          <circle cx="73" cy="87" r="3.4" fill="var(--text-on-brand)" stroke="none" />
          <circle cx="91" cy="87" r="3.4" fill="var(--text-on-brand)" stroke="none" />
          <path d="M86 76q5-3 10 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
          <path d="M73 98q8 7 16 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.2" />
          <path d="M108 40q0-10 10-10t10 9q0 6-6 9t-4 9" fill="none" strokeWidth="4" />
          <circle cx="118" cy="66" r="2.6" fill="currentColor" stroke="none" />
        </g>
      </g>
    </svg>
  );
}
