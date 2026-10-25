import type { PetriProps } from './petri-frame.tsx';

import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

export default function PetriCompass({ label, className }: PetriProps) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      outside={(
        <g transform="rotate(-10 124 46)">
          <circle cx="124" cy="46" r="18" fill="var(--bg-card)" />
          <circle cx="124" cy="46" r="13" fill="none" strokeWidth="1.4" />
          <path d="M124 35l4 11h-8Z" fill="var(--brand-yellow)" strokeWidth="1.4" />
          <path d="M124 57l-4-11h8Z" fill="currentColor" strokeWidth="1.4" />
        </g>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <circle cx="78" cy="86" r="3.4" fill={ink} stroke="none" />
      <circle cx="96" cy="84" r="3.4" fill={ink} stroke="none" />
      <path d="M82 98q5 3 10 0" fill="none" stroke={ink} strokeWidth="2.2" />
    </PetriFrame>
  );
}
