/**
 * AnimatedAtom — Lucide Atom with 3 electrons,
 * one traveling along each orbit simultaneously.
 */
export default function AnimatedAtom({ size = 24, strokeWidth = 1, className = '' }) {
  const orbit1 = 'M 3,12 A 9,4 0 1 1 21,12 A 9,4 0 1 1 3,12';
  const orbit2 = 'M 7.5,4.206 A 9,4 60 1 1 16.5,19.794 A 9,4 60 1 1 7.5,4.206';
  const orbit3 = 'M 16.5,4.206 A 9,4 120 1 1 7.5,19.794 A 9,4 120 1 1 16.5,4.206';

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

      {/* Electron on orbit 1 */}
      <circle r="0.9" fill="#fff" stroke="none">
        <animateMotion dur="2.5s" repeatCount="indefinite" path={orbit1} />
      </circle>

      {/* Electron on orbit 2 */}
      <circle r="0.9" fill="#fff" stroke="none">
        <animateMotion dur="3s" repeatCount="indefinite" path={orbit2} begin="-1s" />
      </circle>

      {/* Electron on orbit 3 */}
      <circle r="0.9" fill="#fff" stroke="none">
        <animateMotion dur="3.5s" repeatCount="indefinite" path={orbit3} begin="-2s" />
      </circle>
    </svg>
  );
}
