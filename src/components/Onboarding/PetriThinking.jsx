import PetriFrame, { ANTENNAE } from './PetriFrame.jsx';

export default function PetriThinking({ label, className }) {
  return (
    <PetriFrame label={label} className={className}>
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <circle cx="73" cy="87" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <circle cx="91" cy="87" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <path d="M86 76q5-3 10 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
      <path d="M73 98q8 7 16 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.2" />
      <path d="M108 40q0-10 10-10t10 9q0 6-6 9t-4 9" fill="none" strokeWidth="4" />
      <circle cx="118" cy="66" r="2.6" fill="currentColor" stroke="none" />
    </PetriFrame>
  );
}
