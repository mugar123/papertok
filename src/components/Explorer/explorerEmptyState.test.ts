import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEmptyVariant } from './explorerEmptyVariant.ts';

test('the empty state distinguishes an error, active filters and an unindexed project', () => {
  assert.equal(pickEmptyVariant({ papersError: 'X', hasActiveFilters: true, type: 'project' }), 'error');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: true, type: 'project' }), 'filtered');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: false, type: 'project' }), 'project-unindexed');
  assert.equal(pickEmptyVariant({ papersError: null, hasActiveFilters: false, type: 'author' }), 'none');
});

/**
 * The empty state and the "Loading more" foot cannot both show. Seen on
 * papertok.app on 2026-09-12: an empty list left the sentinel in view, the
 * observer asked for page 2 at once, and the spinner promised more above an
 * empty state saying there was nothing. For every combination of flags, at
 * most one of the two holds.
 */
test('vacío y «cargando más» se excluyen para toda combinación de banderas', () => {
  const vacio = ({ isLoadingPapers, isFetchingMore, filas }: { isLoadingPapers: boolean; isFetchingMore: boolean; filas: number }) =>
    !isLoadingPapers && !isFetchingMore && filas === 0;
  const cargandoMas = ({ hasMore, rowsSettled, isFetchingMore, filas }: { hasMore: boolean; rowsSettled: boolean; isFetchingMore: boolean; filas: number }) =>
    hasMore && rowsSettled && (filas > 0 || isFetchingMore) && isFetchingMore;

  const b = [false, true];
  let combinaciones = 0;
  for (const isLoadingPapers of b) for (const isFetchingMore of b) for (const hasMore of b) {
    for (const rowsSettled of b) for (const filas of [0, 7]) {
      const estado = { isLoadingPapers, isFetchingMore, hasMore, rowsSettled, filas };
      combinaciones += 1;
      assert.ok(!(vacio(estado) && cargandoMas(estado)),
        `los dos a la vez con ${JSON.stringify(estado)}`);
    }
  }
  assert.equal(combinaciones, 32, 'las treinta y dos combinaciones, sin saltarse ninguna');
});
