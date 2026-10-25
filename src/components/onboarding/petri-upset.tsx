import type { PetriProps } from './petri-frame.tsx';

import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

export default function PetriUpset({ label, className }: PetriProps) {
  return (
    <PetriFrame label={label} className={className}>
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <path d="M66 82l9-4M98 82l-9-4" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
      <circle cx="73" cy="88" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <circle cx="91" cy="88" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <path d="M74 102q7-5 14 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.2" />
      <path d="M103 66q-5 7-2 11 4 2 6-2 0-4-4-9Z" fill="var(--accent-sky)" stroke="var(--text-on-brand)" strokeWidth="1.2" />
    </PetriFrame>
  );
}
