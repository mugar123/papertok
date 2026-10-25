import type { PetriProps } from './petri-frame.tsx';
import PetriFrame, { ANTENNAE } from './petri-frame.tsx';


export default function PetriProfile({ visibility, label, className }: PetriProps & { visibility?: 'public' | 'private' }) {
  return (
    <PetriFrame
      label={label}
      className={className}
      svgProps={{ 'data-private': visibility === 'private' || undefined }}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      <g className="onboarding-petri-smile">
        <circle cx="70" cy="90" r="3.4" fill="var(--text-on-brand)" stroke="none" />
        <circle cx="90" cy="90" r="3.4" fill="var(--text-on-brand)" stroke="none" />
      </g>
      {/* One mouth for both faces: on "private" the smile flattens into a
          straight line where it is, rather than a second mouth arriving. */}
      <path className="onboarding-petri-mouth" d="M74 99q6 5 12 0" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <g className="onboarding-petri-shades">
        <path d="M52 84l7 1.5M101 85.5l7-1.5M79 86h2" fill="none" stroke="var(--text-on-brand)" strokeWidth="2" />
        <rect x="59" y="81" width="20" height="12" rx="4" fill="var(--text-on-brand)" stroke="none" />
        <rect x="81" y="81" width="20" height="12" rx="4" fill="var(--text-on-brand)" stroke="none" />
        <path d="M63 85l3-2M85 85l3-2" fill="none" stroke="var(--brand-yellow)" strokeWidth="1.4" />
      </g>
    </PetriFrame>
  );
}
