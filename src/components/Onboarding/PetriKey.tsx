import PetriFrame, { ANTENNAE } from './PetriFrame.tsx';

// The sign-in dialog's Petri: smiling, a key held up by its bow.
export default function PetriKey({ label, className }) {
  return (
    <PetriFrame
      label={label}
      className={className}
      behind={<path d="M104 100q10-6 9-36" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <path d="M65 90q4-5 8 0M85 90q4-5 8 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.4" />
      <path d="M73 98q8 7 16 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.2" />
      {/* The shaft stands against the page, so it takes the page's ink. */}
      <path d="M116 47V22M116 25h7M116 31h5" fill="none" strokeWidth="3.4" />
      <circle className="petri-prop-line" style={{ '--prop-fill': 'var(--bg-figure-plate)' }} cx="116" cy="54" r="8" fill="var(--bg-figure-plate)" stroke="var(--text-on-brand)" strokeWidth="2.4" />
      <circle cx="116" cy="54" r="2.6" fill="var(--text-on-brand)" stroke="none" />
      {/* The hand grips the bow, so it sits over it. */}
      <circle cx="113" cy="64" r="5" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" strokeWidth="2.2" />
    </PetriFrame>
  );
}
