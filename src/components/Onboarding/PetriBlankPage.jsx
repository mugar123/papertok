import PetriFrame, { ANTENNAE } from './PetriFrame.jsx';

export default function PetriBlankPage({ label, className }) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      // The page, tilted towards her, its lines missing.
      outside={(
        <g transform="rotate(8 123 46)">
          <rect x="106" y="22" width="34" height="46" rx="2" fill="var(--bg-card)" />
          <path d="M112 34h22M112 43h22M112 52h14" fill="none" strokeWidth="2" strokeDasharray="3 3" />
        </g>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      {/* Eyes up on the page, one brow raised: puzzled, not upset. */}
      <circle cx="76" cy="85" r="3.4" fill={ink} stroke="none" />
      <circle cx="94" cy="85" r="3.4" fill={ink} stroke="none" />
      <path d="M69 77h9M88 74q5-4 10-1" fill="none" stroke={ink} strokeWidth="2" />
      <path d="M80 99h9" fill="none" stroke={ink} strokeWidth="2.2" />
    </PetriFrame>
  );
}
