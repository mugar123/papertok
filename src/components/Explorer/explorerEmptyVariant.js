// Picks which flavour of the Explorer's empty state applies. Order matters:
// an error always wins (there is nothing to filter or index if the request
// itself failed), then an active search/filter, then the project-specific
// "OpenAIRE hasn't indexed this yet" case, and only then the generic empty.
// Kept in its own non-JSX module so a plain `node --test` run can import it
// without a JSX-capable loader — see explorerEmptyState.test.js.
export function pickEmptyVariant({ papersError, hasActiveFilters, type }) {
  if (papersError) return 'error';
  if (hasActiveFilters) return 'filtered';
  if (type === 'project') return 'project-unindexed';
  return 'none';
}
