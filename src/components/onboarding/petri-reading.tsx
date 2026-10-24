import type { PetriProps } from './petri-frame.tsx';
import { useState } from 'react';
import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

const ORDER = ['beginner', 'university', 'researcher'];

const ink = 'var(--text-on-brand)';


const LOOKS = {
  beginner: (
    <>
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
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
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
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
// in from that level's side (guest-welcome.css). It stands where the screen's
// kicker was, so it carries the kicker as its name (`label`).
export default function PetriReading({ level = 'university', label, className }: PetriProps & { level?: keyof typeof LOOKS }) {
  const [shown, setShown] = useState(level);
  const [from, setFrom] = useState(0);
  if (shown !== level) {
    setShown(level);
    setFrom(Math.sign(ORDER.indexOf(level) - ORDER.indexOf(shown)) || 1);
  }
  return (
    <PetriFrame
      label={label}
      className={className}
      bodyKey={level}
      bodyProps={{ className: from ? 'onboarding-petri-body petri-swap' : 'onboarding-petri-body', style: { '--petri-from': from } }}
    >
      {LOOKS[level] ?? LOOKS.university}
    </PetriFrame>
  );
}
