import { useId } from 'react';
import { PROFILE_VISIBILITY } from '../../services/userProfileService.js';

// Petri, the mascot, on the profile screen, drawn like the greeting's
// (PetriWelcome): smiling while the profile is public or not yet chosen; on
// "private" a pair of dark glasses drops onto her face and the smile
// flattens in place. The faces swap by CSS transition (OnboardingFlow.css),
// so flipping the choice quickly retargets instead of restarting. It stands
// where the screen's kicker was, so it carries the kicker as its name; the
// choice itself is announced by the radio group, not the drawing.
export default function PetriProfile({ visibility, label, className }) {
  const hatch = useId();
  return (
    // The greeting's crop, so every screen's Petri shares a size and an axis.
    <svg
      viewBox="14 22 128 124"
      role="img"
      aria-label={label}
      className={className}
      data-private={visibility === PROFILE_VISIBILITY.private || undefined}
    >
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="1.4" height="4" fill="currentColor" />
        </pattern>
      </defs>
      <g stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <ellipse cx="78" cy="128" rx="62" ry="15" fill="var(--bg-primary)" />
        <ellipse cx="78" cy="124" rx="54" ry="10" fill={`url(#${hatch})`} strokeWidth="1.6" />
        <g className="onboarding-petri-body">
          <path d="M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z" fill="var(--brand-yellow)" stroke="var(--brand-yellow)" />
          <path d="M62 66l-4-8M78 62l-1-9M94 64l3-8" fill="none" strokeWidth="2" />
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
        </g>
      </g>
    </svg>
  );
}
