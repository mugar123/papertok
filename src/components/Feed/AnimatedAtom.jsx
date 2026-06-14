/**
 * AnimatedAtom — Same visual as Lucide Atom,
 * with a single small electron traveling along one orbit.
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
      {/* Three orbit ellipses */}
      <ellipse cx="12" cy="12" rx="9" ry="4" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />

      {/* Nucleus */}
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />

      {/* Single electron */}
      <circle r="0.9" fill="#fff" stroke="none">
        <animateMotion dur="3s" repeatCount="indefinite" path={orbitPath} />
      </circle>
    </svg>
  );
}
