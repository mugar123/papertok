/**
 * Which reader experience a pointer gets.
 *
 * A fine pointer gets the full one: selection menu over the passage,
 * annotations, highlights, "explain this". A coarse pointer gets the trimmed
 * island — level and download, nothing selection-driven (2026-08-29): the
 * touch selection route this module used to arbitrate (settle timing,
 * usability checks) was removed with the mobile annotations UI, and lives in
 * git history for the day "explain this" returns to mobile with the redesign
 * it needs.
 */
export function pickSelectionRoute({ coarsePointer }) {
  return coarsePointer ? 'bar' : 'menu';
}
