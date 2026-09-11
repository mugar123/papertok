import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickEmptyVariant } from './explorerEmptyVariant.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the empty state distinguishes an error, active filters and an unindexed project', () => {
  assert.equal(pickEmptyVariant({ papersError: 'X', hasActiveFilters: true, type: 'project' }), 'error');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: true, type: 'project' }), 'filtered');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: false, type: 'project' }), 'project-unindexed');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: false, type: 'author' }), 'none');
});

// `pickEmptyVariant` lives in its own module specifically so it stays pure
// and independent of ExplorerEmptyState.jsx's component export — unlike
// AuthContext.jsx and its siblings, nothing here forces the two to share a
// binding. A blanket `eslint-disable` for react-refresh/only-export-components
// would silence that rule for the whole file, including any future export
// the rule should genuinely catch. This guard is what stops the pragma (or
// the re-export that justified it) from creeping back in.
test('ExplorerEmptyState.jsx does not blanket-disable react-refresh/only-export-components', async () => {
  const source = await read('./ExplorerEmptyState.jsx');
  assert.doesNotMatch(source, /eslint-disable.*only-export-components/);
});

/**
 * The authors tab rendered the same empty state whatever had happened, and
 * its copy — "Try a different spelling, or clear the search to see everyone
 * on this entity" — asks somebody who never typed anything to clear a search
 * they do not have. That is the falsehood this redesign existed to remove,
 * reintroduced in copy the redesign itself wrote. `debouncedSearch` sits at
 * the call site and says which of the two happened.
 */
test('the authors tab blames the search only when there is one', async () => {
  const explorer = await read('./EntityExplorer.jsx');
  assert.match(
    explorer,
    /<ExplorerEmptyState variant=\{debouncedSearch \? 'authors' : 'authors-none'\} isEnglish=\{isEnglish\} \/>/,
    'the variant is picked from whether a search is actually running',
  );

  const emptyState = await read('./ExplorerEmptyState.jsx');
  const copy = emptyState.match(/ {2}'authors-none': \{\n {4}en: \[[^\]]*\],\n {4}es: \[[^\]]*\],\n {2}\},/);
  assert.ok(copy, "the 'authors-none' variant carries its own copy, in both languages");
  assert.doesNotMatch(
    copy[0],
    /search|spelling|búsqueda|grafía/i,
    'no search is mentioned to a reader who never ran one',
  );
  assert.match(
    emptyState,
    /variant === 'authors' \|\| variant === 'authors-none' \? Users/,
    'both author variants keep the people icon',
  );
});
