/**
 * AnimatedAtom — Lucide Atom with a single electron
 * that travels sequentially along all 3 orbits.
 * Uses chained SVG <animateMotion> for each orbit path.
 */
export default function AnimatedAtom({ size = 24, strokeWidth = 1, className = '' }) {
  // Orbit paths — ellipse rx=9 ry=4 centered at (12,12), at 0°, 60°, 120°
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

      {/* Single electron — chains through all 3 orbits */}
      <circle r="0.9" fill="#fff" stroke="none">
        <animateMotion id="o1" dur="2.5s" begin="0s;o3.end" path={orbit1} />
        <animateMotion id="o2" dur="2.5s" begin="o1.end" path={orbit2} />
        <animateMotion id="o3" dur="2.5s" begin="o2.end" path={orbit3} />
      </circle>
    </svg>
  );
}
