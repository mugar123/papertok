import './Handle.css';

/**
 * A handle wherever one shows, which is now only the onboarding's address
 * window. The handle itself is machine
 * data and keeps the mono voice of its surroundings; the "@" is not — set in
 * Plex Mono it is a cramped, low-slung glyph that reads as a smudge next to
 * the letters — so it takes the body face at the same size. The sign is kept
 * in the text (not hidden) because "at nico" is how a handle is said.
 */
export default function Handle({ handle, className = '' }) {
  return (
    <span className={`handle ${className}`.trim()}>
      <span className="handle-at">@</span>
      {handle}
    </span>
  );
}
