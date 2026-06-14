/**
 * AnimatedAtom — Same visual as Lucide's Atom icon,
 * but with glowing electrons that travel along each orbit path.
 * Uses SVG <animateMotion> for buttery-smooth, GPU-friendly animation.
 */
export default function AnimatedAtom({ size = 24, strokeWidth = 1, className = '' }) {
  // Ellipse path for animateMotion (rx=9, ry=4, centered at 12,12)
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
      {/* Three orbit ellipses — identical to Lucide Atom */}
      <ellipse cx="12" cy="12" rx="9" ry="4" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />

      {/* Nucleus dot */}
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />

      {/* Electron on orbit 1 */}
      <g>
        <circle r="1.2" fill="#fff" stroke="none" opacity="0.9">
          <animateMotion dur="3s" repeatCount="indefinite" path={orbitPath} />
        </circle>
      </g>

      {/* Electron on orbit 2 (rotated 60°) */}
      <g transform="rotate(60 12 12)">
        <circle r="1.2" fill="#fff" stroke="none" opacity="0.9">
          <animateMotion dur="4s" repeatCount="indefinite" path={orbitPath} begin="-1.3s" />
        </circle>
      </g>

      {/* Electron on orbit 3 (rotated 120°) */}
      <g transform="rotate(120 12 12)">
        <circle r="1.2" fill="#fff" stroke="none" opacity="0.9">
          <animateMotion dur="3.5s" repeatCount="indefinite" path={orbitPath} begin="-2s" />
        </circle>
      </g>
    </svg>
  );
}
