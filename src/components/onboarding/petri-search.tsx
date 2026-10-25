import type { PetriProps } from './petri-frame.tsx';

import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

export default function PetriSearch({ label, className }: PetriProps) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      outside={(
        <g transform="rotate(-12 122 44)">
          <path d="M133 55l11 11" fill="none" strokeWidth="4.2" strokeLinecap="round" />
          <circle cx="122" cy="44" r="15" fill="var(--bg-card)" strokeWidth="2" />
          <path d="M113 38q4-6 11-6" fill="none" strokeWidth="1.4" />
        </g>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <circle cx="80" cy="82" r="3.4" fill={ink} stroke="none" />
      <circle cx="98" cy="80" r="3.4" fill={ink} stroke="none" />
      <path d="M71 74q4-2 9-1M90 71q5-2 10 0" fill="none" stroke={ink} strokeWidth="2" />
      <path d="M83 98h9" fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
    </PetriFrame>
  );
}
