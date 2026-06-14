/**
 * AnimatedAtom — Identical to Lucide Atom visually,
 * with glowing electrons traveling along each orbit.
 * Uses SVG <animateMotion> + <filter> glow so electrons
 * remain visible even when parent opacity is very low.
 */
export default function AnimatedAtom({ size = 24, strokeWidth = 1, className = '' }) {
  const orbitPath = 'M 3,12 A 9,4 0 1 1 21,12 A 9,4 0 1 1 3,12';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <defs>
        <filter id="eGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Three orbit ellipses */}
      <ellipse cx="12" cy="12" rx="9" ry="4" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />

      {/* Nucleus */}
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />

      {/* Electron 1 — orbit 0° */}
      <circle r="1.6" fill="#fff" stroke="none" filter="url(#eGlow)">
        <animateMotion dur="3s" repeatCount="indefinite" path={orbitPath} />
      </circle>

      {/* Electron 2 — orbit 60° */}
      <g transform="rotate(60 12 12)">
        <circle r="1.6" fill="#fff" stroke="none" filter="url(#eGlow)">
          <animateMotion dur="3.7s" repeatCount="indefinite" path={orbitPath} begin="-1.2s" />
        </circle>
      </g>

      {/* Electron 3 — orbit 120° */}
      <g transform="rotate(120 12 12)">
        <circle r="1.6" fill="#fff" stroke="none" filter="url(#eGlow)">
          <animateMotion dur="4.2s" repeatCount="indefinite" path={orbitPath} begin="-2.5s" />
        </circle>
      </g>
    </svg>
  );
}
