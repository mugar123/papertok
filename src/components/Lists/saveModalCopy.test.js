import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: la fila de Read later dice solo «Read later», sin subtítulo', async () => {
  const src = strip(await read('./SaveToListModal.jsx'));
  assert.match(src, /readLaterOn: 'Read later'/);
  assert.match(src, /readLaterOff: 'Read later'/);
  assert.match(src, /readLaterOn: 'Leer después'/);
  assert.doesNotMatch(src, /readLaterOnHint|readLaterOffHint/, 'los hints han desaparecido con su render');
});

test('SOURCE: la tarjeta no dice «Open source»', async () => {
  const src = strip(await read('../Feed/PaperCard.jsx'));
  assert.doesNotMatch(src, /'Open source'|'Abrir fuente'/);
  assert.match(src, /'Source'/);
});
