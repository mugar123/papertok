import type { PetriProps } from './petri-frame.tsx';

import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

export default function PetriLost({ label, className, code = '404' }: PetriProps & { code?: string }) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={className}
      viewBox="14 14 132 132"
      outside={(
        <>
          <path d="M126 46q-10 14-24 18" fill="none" strokeWidth="1.6" strokeDasharray="3 4" />
          <text x="128" y="38" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-mono)" fontSize="15" fontWeight="600">{code}</text>
        </>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      {/* The star pose's face, looking up at the code instead. */}
      <circle cx="79" cy="83" r="3.4" fill={ink} stroke="none" />
      <circle cx="97" cy="83" r="3.4" fill={ink} stroke="none" />
      <path d="M70 76q4-3 9-2M89 73q5-3 10-1" fill="none" stroke={ink} strokeWidth="2" />
      <circle cx="87" cy="99" r="2.6" fill={ink} stroke="none" />
    </PetriFrame>
  );
}
