import { useId } from 'react';
import './Petri.css';


export const BODY = 'M48 124c-14-20-4-56 30-58 26-2 40 18 38 36-1 12-3 20-6 22Z';
// The three antennae on top of her head, drawn by most poses and the stamp.
export const ANTENNAE = 'M62 66l-4-8M78 62l-1-9M94 64l3-8';

// Diagonal hatching: the dish's fill, and the flask's liquid.
export function Hatch({ id, fill }) {
  return (
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
      <rect width="1.4" height="4" fill={fill} />
    </pattern>
  );
}

/**
 * What every pose of Petri shares: the svg, the hatch the dish is filled
 * with, the dish, and the yellow body. A pose (`Petri.jsx` picks one by name)
 * brings only its own parts:
 *
 * - `behind`: drawn before the body — an arm reaching up behind her.
 * - `children`: drawn on the body — face, hands, whatever she holds.
 * - `defs`: extra patterns its parts fill with.
 * - `bodyKey` / `bodyProps`: on the body group, for a pose that remounts or
 *   animates it (a new key replays the swap).
 *
 * With a `label` the drawing is an image with that name (it stands in for a
 * screen's kicker); without one it is decoration, hidden from assistive tech.
 */
export default function PetriFrame({
  label,
  className,
  defs,
  behind,
  children,
  bodyKey,
  bodyProps,
  svgProps,
}) {
  const hatch = useId();
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true, focusable: 'false' };
  return (
    <svg viewBox="14 22 128 124" className={className ? `petri ${className}` : 'petri'} {...a11y} {...svgProps}>
      <defs>
        <Hatch id={hatch} fill="currentColor" />
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
      </g>
    </svg>
  );
}
