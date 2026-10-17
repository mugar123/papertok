import PetriFrame, { ANTENNAE } from './PetriFrame.jsx';
import { STAR_PATH } from '../../utils/starPath.js';

export default function PetriStar({ label, className }) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      outside={(
        <>
          <path d="M126 46q-10 14-24 18" fill="none" strokeWidth="1.6" strokeDasharray="3 4" />
          <path d={STAR_PATH} transform="translate(112 18) scale(1.15)" fill="var(--bg-card)" strokeWidth="1.8" />
        </>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      {/* Eyes up on the star, brows raised, a small "o": wonder. */}
      <circle cx="79" cy="83" r="3.4" fill={ink} stroke="none" />
      <circle cx="97" cy="83" r="3.4" fill={ink} stroke="none" />
      <path d="M70 76q4-3 9-2M89 73q5-3 10-1" fill="none" stroke={ink} strokeWidth="2" />
      <circle cx="87" cy="99" r="2.6" fill={ink} stroke="none" />
    </PetriFrame>
  );
}
