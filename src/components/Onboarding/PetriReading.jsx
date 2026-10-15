import { useId, useState } from 'react';

const ORDER = ['beginner', 'university', 'researcher'];

const ink = 'var(--text-on-brand)';

// What Petri wears for each reading level (obradither/landing/petri.html):
// as herself for Beginner (`petri-idle`), in her mortarboard for University
// (`petri-graduate`, the cap following her head) and in lab goggles for
// Researcher. Each draws its face and props over the shared body.
const LOOKS = {
  beginner: (
    <>
      <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" strokeWidth="2" />
      <circle cx="70" cy="90" r="3.4" fill={ink} stroke="none" />
      <circle cx="90" cy="90" r="3.4" fill={ink} stroke="none" />
      <path d="M74 99q6 5 12 0" fill="none" stroke={ink} strokeWidth="2" />
    </>
  ),
  university: (
    <>
      <path d="M65 90q4-5 8 0M85 90q4-5 8 0" fill="none" stroke={ink} strokeWidth="2.4" />
      <path d="M71 98q8 7 16 0" fill="none" stroke={ink} strokeWidth="2.2" />
      {/* The tassel, hanging behind the cap. */}
      <path d="M80 58l40 3v17" fill="none" stroke={ink} strokeWidth="3.6" />
      <path d="M80 58l40 3v17" fill="none" stroke="var(--brand-yellow)" strokeWidth="1.6" />
      <path d="M117 78h6l-1 7h-4Z" fill="var(--brand-yellow)" stroke={ink} strokeWidth="1.2" />
      <path d="M53 76C51 64 60 60 80 60S109 64 107 76Q80 85 53 76Z" fill={ink} stroke="none" />
      <path d="M80 46l44 12-44 12-44-12Z" fill={ink} stroke="none" />
    </>
  ),
  researcher: (
    <>
      <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" strokeWidth="2" />
      {/* Lab goggles: the strap round her head, two lenses over her eyes. */}
      <path d="M47 88q33-6 68 0" fill="none" stroke={ink} strokeWidth="3" />
      <circle cx="70" cy="89" r="8.5" fill="var(--bg-figure-plate)" stroke={ink} strokeWidth="3" />
      <circle cx="91" cy="89" r="8.5" fill="var(--bg-figure-plate)" stroke={ink} strokeWidth="3" />
      <circle cx="70" cy="90" r="3" fill={ink} stroke="none" />
      <circle cx="91" cy="90" r="3" fill={ink} stroke="none" />
      <path d="M75 104q6 4 12 0" fill="none" stroke={ink} strokeWidth="2" />
    </>
  ),
};

// The guest welcome's reading-depth prop: Petri dressed for the level picked
// (`level`). She rises in with the screen; a later pick slides her new look
// in from that level's side (GuestWelcome.css). It stands where the screen's
// kicker was, so it carries the kicker as its name (`label`).
export default function PetriReading({ level = 'university', label, className }) {
  const hatch = useId();
  const [shown, setShown] = useState(level);
  const [from, setFrom] = useState(0);
  if (shown !== level) {
    setShown(level);
    setFrom(Math.sign(ORDER.indexOf(level) - ORDER.indexOf(shown)) || 1);
  }
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
        <g key={level} className={from ? 'onboarding-petri-body petri-swap' : 'onboarding-petri-body'} style={{ '--petri-from': from }}>
          <path d="M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" />
          {LOOKS[level] ?? LOOKS.university}
        </g>
      </g>
    </svg>
  );
}
