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

const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');

/**
 * «No hay publicaciones» y «Cargando más artículos…» no pueden convivir.
 * Visto en papertok.app el 12-09-2026, tema «Constant (computer
 * programming)»: la lista vacía deja el centinela a la vista desde el primer
 * fotograma, el observador dispara la página 2 en el acto, y como
 * `isLoadingPapers` sólo cubre la página 1, la pantalla mostraba el spinner
 * prometiendo más y, debajo, el vacío negando que hubiera nada.
 */
test('SOURCE: el vacío espera a que no quede ninguna página en vuelo', async () => {
  const jsx = strip(await read('./EntityExplorer.jsx'));

  for (const [tab, condicion] of [
    ['publicaciones', /\{!isLoadingPapers && !isFetchingMore && filteredPapers\.length === 0 && \(/],
    ['autores', /\{!isLoadingAuthors && !isFetchingMoreAuthors && entityAuthors\.length === 0 && \(/],
  ]) {
    assert.match(jsx, condicion,
      `${tab}: el vacío tiene que descartar TAMBIÉN la carga de las páginas siguientes, no sólo la primera`);
  }
});

/**
 * La otra mitad: sin ninguna fila, «Sigue bajando para ver más» invita a
 * recorrer una lista que no existe. Con la lista vacía el pie sólo aparece
 * mientras de verdad está trayendo algo.
 */
test('SOURCE: el pie de la lista no invita a bajar por una lista vacía', async () => {
  const jsx = strip(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /\{hasMore && rowsSettled && \(filteredPapers\.length > 0 \|\| isFetchingMore\) && \(/,
    'publicaciones: con cero filas, sólo mientras se trae una página');
  assert.match(jsx, /\{hasMoreAuthors && \(entityAuthors\.length > 0 \|\| isFetchingMoreAuthors\) && \(/,
    'autores: lo mismo');
});

/**
 * Y la propiedad que importa, por encima de cómo esté escrita: para cada
 * combinación posible de banderas, el vacío y el pie cargando nunca son
 * ciertos a la vez.
 */
test('vacío y «cargando más» se excluyen para toda combinación de banderas', () => {
  const vacio = ({ isLoadingPapers, isFetchingMore, filas }) =>
    !isLoadingPapers && !isFetchingMore && filas === 0;
  const cargandoMas = ({ hasMore, rowsSettled, isFetchingMore, filas }) =>
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
