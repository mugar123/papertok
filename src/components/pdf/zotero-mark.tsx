// Zotero's Z (Simple Icons, after zotero.org/support/brand), in `currentColor` among the page's icons.
// The viewBox adds the margin a Phosphor glyph keeps inside its box, so the Z matches their size.
export function ZoteroMark({ size }: { size?: number; 'aria-hidden'?: boolean | 'true' }) {
  return (
    <svg width={size} height={size} viewBox="-4 -4 32 32" fill="currentColor" aria-hidden="true">
      <path d="M21.231 2.462 7.18 20.923h14.564V24H2.256v-2.462L16.308 3.076H2.975V0h18.256v2.462z" />
    </svg>
  );
}
