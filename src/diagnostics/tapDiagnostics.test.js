import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests. The diagnostic exists for one bug that only the user's phone
 * shows (docs/AUDITORIA-PESTANAS-MOVIL-2026-09-18.md); it must cost nothing
 * to everyone else, and it must see the tap before anything can cancel it.
 */
test('SOURCE: the diagnostic is a lazy chunk behind the flag, never a static import', async () => {
  const main = await read('../main.jsx');
  assert.doesNotMatch(main, /^import[^\n]*tapDiagnostics/m, 'no static import in main.jsx');
  assert.match(main, /import\('\.\/diagnostics\/tapDiagnostics\.js'\)/);
  assert.match(main, /sessionStorage\.getItem\('papertok_tapdiag'\) === '1'/);
  assert.match(main, /tapdiag=\(\[01\]\)/, 'the flag can also turn it off');
  assert.match(main, /window\.location\.search\} \$\{window\.location\.hash/, 'read on either side of the #');
});

test('SOURCE: it listens in the capture phase, passively, and leaves its own panel out of the record', async () => {
  const src = await read('./tapDiagnostics.js');
  assert.match(src, /document\.addEventListener\(type, onNavEvent, \{ capture: true, passive: true \}\)/);
  for (const type of ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointercancel', 'click']) {
    assert.match(src, new RegExp(`'${type}'`), `${type} is recorded`);
  }
  assert.match(src, /if \(target\.closest\('#tapdiag'\)\) return;/);
  assert.match(src, /history\[name\] = \(state, title, url\)/, 'pushState and replaceState are wrapped');
  assert.match(src, /for \(const ms of \[300, 1000, 2500\]\)/, 'the route is looked at after each click');
  assert.match(src, /elementFromPoint\(pt\.x, pt\.y\)/, 'what is under the finger is recorded');
  // Plain DOM on purpose: it has to keep recording whatever React is doing.
  assert.doesNotMatch(src, /from 'react'/);
});
