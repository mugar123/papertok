import type { PetriProps } from './petri-frame.tsx';

import PetriFrame, { ANTENNAE } from './petri-frame.tsx';

/**
 * Petri holding a balloon by its string, the balloon marked with who or what
 * she is about to let go of: the unfollow question. `released` lets go of
 * it — the string goes slack and the balloon drifts off (petri.css). The
 * balloon's colours come from `--balloon-fill` and `--balloon-ink` on the
 * svg, so the caller tints it by the kind of follow.
 */
export default function PetriFarewell({ label, className, initials, released }: PetriProps & { initials?: string; released?: boolean }) {
  const ink = 'var(--text-on-brand)';
  return (
    <PetriFrame
      label={label}
      className={[className, released && 'is-released'].filter(Boolean).join(' ') || undefined}
      viewBox="12 0 146 146"
      behind={<path d="M104 96l16-34" fill="none" stroke="var(--brand-yellow)" strokeWidth="9" />}
      outside={(
        <>
          <path className="petri-balloon-string" d="M121 59q-3-7 3-11t4-8" fill="none" strokeWidth="1.4" />
          <g className="petri-balloon">
            <path d="M125 37.5l3 4.5 3-4.5Z" fill="var(--bg-card)" strokeWidth="1.4" />
            <ellipse cx="128" cy="19" rx="16" ry="18.5" fill="var(--bg-card)" strokeWidth="1.8" />
            <ellipse cx="128" cy="19" rx="15.1" ry="17.6" fill="var(--balloon-fill, var(--bg-secondary))" stroke="none" />
            <path d="M117 13q2-6 8-8" fill="none" stroke="var(--bg-card)" strokeWidth="2.4" />
            <text
              x="128"
              y="23.5"
              textAnchor="middle"
              fontSize={initials && initials.length > 1 ? 12 : 14}
              fill="var(--balloon-ink, var(--text-primary))"
              stroke="none"
              style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.02em' }}
            >
              {initials}
            </text>
          </g>
        </>
      )}
    >
      <path d={ANTENNAE} fill="none" strokeWidth="2" />
      {/* Eyes up on the balloon, brows lifted in the middle, a small wavering
          mouth: sorry to see it go. */}
      <path d="M69 77q5-4 10-2M88 74q5-3 10 0" fill="none" stroke={ink} strokeWidth="2" />
      <circle cx="78" cy="83" r="3.2" fill={ink} stroke="none" />
      <circle cx="96" cy="82" r="3.2" fill={ink} stroke="none" />
      <path d="M79 99q4-3 8 0t8 0" fill="none" stroke={ink} strokeWidth="2" />
    </PetriFrame>
  );
}
