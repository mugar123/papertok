import PetriFrame from './PetriFrame.jsx';

// Petri, the mascot, thinking (obradither/landing/petri.html,
// `petri-thinking`), in a happier mood: no hands, eyes up, one brow raised,
// a smile and a question mark over her head. The about screen's prop,
// for "say a little about yourself", drawn like the greeting's
// (PetriWelcome): body outlined in its own yellow, the dish, the cilia and
// the question mark in ink. It stands where the screen's kicker was, so it
// carries the kicker as its name (`label`).
export default function PetriThinking({ label, className }) {
  return (
    <PetriFrame label={label} className={className}>
      <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" strokeWidth="2" />
      <circle cx="73" cy="87" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <circle cx="91" cy="87" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      <path d="M86 76q5-3 10 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
      <path d="M73 98q8 7 16 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2.2" />
      <path d="M108 40q0-10 10-10t10 9q0 6-6 9t-4 9" fill="none" strokeWidth="4" />
      <circle cx="118" cy="66" r="2.6" fill="currentColor" stroke="none" />
    </PetriFrame>
  );
}
