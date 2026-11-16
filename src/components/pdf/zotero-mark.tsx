/** A Z drawn on Phosphor's 256 grid with its regular stroke, so it sits among the page's icons. */
export function ZoteroMark({ size }: { size?: number; 'aria-hidden'?: boolean | 'true' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M64 56h128L64 200h128" />
    </svg>
  );
}
