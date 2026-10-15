import { useId } from 'react';
import './Petri.css';

// Petri's silhouette, the same in every pose and in the stamp
// (obradither/landing/petri.html).
export const BODY = 'M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z';

/**
 * What every pose of Petri shares: the svg, the hatch the dish is filled
 * with, the dish, and the yellow body. A pose (`Petri.jsx` picks one by name)
 * brings only its own parts:
 *
 * - `behind`: drawn before the body — an arm reaching up behind her.
 * - `children`: drawn on the body — face, hands, whatever she holds.
 * - `outside`: drawn after the body group, so it does not move with her idle
 *   animation — a speech bubble beside her.
 * - `defs`: extra patterns its parts fill with.
 * - `bodyKey` / `bodyProps`: on the body group, for a pose that remounts or
 *   animates it (a new key replays the swap).
 * - `viewBox`: the crop. The default is cut to the figure, card included, so
 *   centring the box centres Petri; the square one leaves room beside her.
 *
 * With a `label` the drawing is an image with that name (it stands in for a
 * screen's kicker); without one it is decoration, hidden from assistive tech.
 */
export default function PetriFrame({
  label,
  className,
  viewBox = '14 22 128 124',
  defs,
  behind,
  children,
  outside,
  bodyKey,
  bodyProps,
  svgProps,
}) {
  const hatch = useId();
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true, focusable: 'false' };
  return (
    <svg viewBox={viewBox} className={className} {...a11y} {...svgProps}>
      <defs>
        <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="1.4" height="4" fill="currentColor" />
        </pattern>
        {defs}
      </defs>
      <g stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round">
        <ellipse cx="78" cy="128" rx="62" ry="15" fill="var(--bg-primary)" />
        <ellipse cx="78" cy="124" rx="54" ry="10" fill={`url(#${hatch})`} strokeWidth="1.6" />
        <g key={bodyKey} className="onboarding-petri-body" {...bodyProps}>
          {behind}
          <path d={BODY} fill="var(--brand-yellow)" stroke="var(--brand-yellow)" />
          {children}
        </g>
        {outside}
      </g>
    </svg>
  );
}
