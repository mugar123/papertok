import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');

/**
 * The strip that says a list came back incomplete. Measured on papertok.app
 * 2026-09-12, it rendered BELOW the infinite-scroll sentinel, so the foot of
 * the list read "Loading more articles…" and immediately under it "Some
 * publications could not be loaded" — two opposite claims stacked. It also
 * stopped 420px short of the rows it was talking about.
 */
test('SOURCE: el aviso parcial va antes del centinela, en las dos pestañas', async () => {
  const jsx = strip(await read('./EntityExplorer.jsx'));

  for (const [tab, banner, sentinel] of [
    ['publicaciones', "getUiErrorMessage('PARTIAL_PUBLICATIONS_LOAD_FAILED'", 'ref={observerRef}'],
    ['autores', "getUiErrorMessage('PARTIAL_AUTHORS_LOAD_FAILED'", 'ref={observerAuthorsRef}'],
  ]) {
    const atBanner = jsx.indexOf(banner);
    const atSentinel = jsx.indexOf(sentinel);
    assert.ok(atBanner > -1, `${tab}: sigue existiendo el aviso`);
    assert.ok(atSentinel > -1, `${tab}: sigue existiendo el centinela`);
    assert.ok(atBanner < atSentinel,
      `${tab}: el aviso debe leerse ANTES del "Cargando más…", no debajo`);
  }
});

/**
 * `alert` interrumpe; esto es una nota pasiva al pie de una lista que, con la
 * lista larga, queda a más de diez mil píxeles de scroll. `status` es cortés,
 * que es lo que corresponde a dónde vive.
 */
test('SOURCE: el aviso parcial se anuncia como status, no como alert', async () => {
  const jsx = strip(await read('./EntityExplorer.jsx'));
  const strips = [...jsx.matchAll(/<div className="explorer-inline-error" role="(\w+)">/g)].map((m) => m[1]);
  assert.equal(strips.length, 2, 'las dos tiras, publicaciones y autores');
  assert.deepEqual(strips, ['status', 'status']);
});

/**
 * Es un pie de las filas, no prosa: las abarca. Un tope de 820px contra una
 * lista de 1240px lo dejaba corto y alineado a la izquierda, con aspecto de
 * bloque recortado.
 */
test('SOURCE: la tira abarca las filas, sin tope de ancho', async () => {
  const css = strip(await read('./EntityExplorer.css'));
  const rule = css.slice(css.indexOf('.explorer-inline-error {'), css.indexOf('}', css.indexOf('.explorer-inline-error {')));
  assert.ok(rule.length > 0, 'la regla sigue ahí');
  assert.doesNotMatch(rule, /max-width/, 'ningún tope que la deje más corta que la lista');
  assert.match(rule, /justify-content: space-between/, 'el texto a un lado y el botón al otro');
});
