import type { PetriProps } from './PetriFrame.tsx';

import PetriFrame, { ANTENNAE } from './PetriFrame.tsx';

export default function PetriDownload({ label, className }: PetriProps) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className ? `petri-loader ${className}` : 'petri-loader'}
      viewBox="14 14 132 132"
      outside={(
        <>
          <path className="petri-download-arrow" d="M123 16v11M118 23l5 5 5-5" fill="none" strokeWidth="2.5" />
          <g transform="rotate(8 123 54)">
            <rect x="106" y="34" width="34" height="40" rx="2" fill="var(--bg-card)" />
            <path className="petri-download-line" style={{ '--line': 0 }} d="M112 45h22" fill="none" strokeWidth="2" />
            <path className="petri-download-line" style={{ '--line': 1 }} d="M112 53h22" fill="none" strokeWidth="2" />
            <path className="petri-download-line" style={{ '--line': 2 }} d="M112 61h14" fill="none" strokeWidth="2" />
          </g>
        </>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <circle cx="77" cy="84" r="3.4" fill={ink} stroke="none" />
      <circle cx="95" cy="83" r="3.4" fill={ink} stroke="none" />
      <path d="M70 76q4-3 9-1M89 74q5-3 10 0" fill="none" stroke={ink} strokeWidth="2" />
      <path d="M80 97q5 4 10 0" fill="none" stroke={ink} strokeWidth="2.2" />
    </PetriFrame>
  );
}
