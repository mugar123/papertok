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
