import type { PetriProps } from './petri-frame.tsx';

import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

export default function PetriLetGo({ label, className }: PetriProps) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      outside={(
        <>
          <g transform="rotate(16 124 40)">
            <rect x="110" y="20" width="28" height="36" rx="2" fill="var(--bg-card)" />
            <path d="M115 29h18M115 36h18M115 43h11" fill="none" strokeWidth="2" />
          </g>
          <path d="M100 58l-6 4M104 66l-7 2" fill="none" strokeWidth="2" />
        </>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <path d="M70 78q5-3 10 0M88 76q5-3 10 0" fill="none" stroke={ink} strokeWidth="2" />
      <circle cx="76" cy="86" r="3.2" fill={ink} stroke="none" />
      <circle cx="93" cy="85" r="3.2" fill={ink} stroke="none" />
      <ellipse cx="84" cy="99" rx="3.2" ry="3.8" fill={ink} stroke="none" />
    </PetriFrame>
  );
}
