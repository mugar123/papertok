import type { PetriProps } from './PetriFrame.tsx';

import PetriFrame, { ANTENNAE } from './PetriFrame.tsx';

export default function PetriBell({ label, className }: PetriProps) {
  const ink = 'var(--text-on-brand)';
  const bell = 'var(--tint-amber-fg)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      behind={<path d="M104 100q14-10 15-62" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <circle cx="74" cy="86" r="3.4" fill={ink} stroke="none" />
      <circle cx="92" cy="86" r="3.4" fill={ink} stroke="none" />
      <path d="M70 78q5-3 9-1M87 77q5-3 10 0" fill="none" stroke={ink} strokeWidth="2" />
      <path d="M77 97q6 8 12 0Z" fill={ink} stroke={ink} strokeWidth="1.6" />
      {/* The bell, tipped mid-ring, hanging from the hand. */}
      <g transform="translate(120 36) rotate(-24)">
        <circle cy="27" r="3.2" fill={ink} stroke="none" />
        <path className="petri-prop-line" style={{ '--prop-fill': bell }} d="M-3 4q-9 2-9 14l-3 6h30l-3-6q0-12-9-14Z" fill={bell} stroke={ink} />
        <path d="M-6 12q1-4 4-5" fill="none" stroke={ink} strokeWidth="1.6" />
      </g>
      <path d="M107 26q-4 6-2 12M146 40q4 7 0 14M152 34q6 11 0 24" fill="none" strokeWidth="2" />
      <circle cx="119" cy="36" r="5" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" strokeWidth="2.2" />
    </PetriFrame>
  );
}
