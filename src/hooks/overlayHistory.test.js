import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { clearStaleOverlayMarker, createOverlayHistory } from './useOverlayHistory.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * A history whose `back()` pops and notifies synchronously — good enough for
 * the cases below where nothing else touches history between an arm/disarm
 * pair and the assertion that follows it.
 *
 * Two ways it is NOT a browser, so no test below may talk about
 * `history.length`: a real `back()` leaves the entry it steps off in place as
 * a forward entry (this one deletes it), and a real `pushState` truncates the
 * forward list (this one cannot, having none). What the depth of `stack`
 * measures here is how many entries this controller OWNS — one per open, none
 * after a close — which is the invariant these tests are about.
 */
function fakeHistory(initial = { idx: 3, key: 'k' }) {
  const stack = [initial]; const listeners = new Set();
  return {
    history: {
      get state() { return stack[stack.length - 1]; },
      pushState(state) { stack.push(state); },
      replaceState(state) { stack[stack.length - 1] = state; },
      back() { stack.pop(); listeners.forEach(fn => fn()); },
    },
    listen: (fn) => listeners.add(fn), unlisten: (fn) => listeners.delete(fn),
    stack,
  };
}

/**
 * A history whose `back()` only QUEUES a pop — `flushOneBack()` is the
 * separate step that actually performs it and notifies listeners. Real
 * browsers work this way: `history.back()` schedules a session-history
 * traversal; the `popstate` it produces does not fire in the same script
 * turn that called it. This is what lets a second `arm()` land in the gap
 * between a disarm's `history.back()` call and that pop actually happening —
 * exactly what React 18 StrictMode's synchronous dev-only mount → cleanup →
 * mount does to this hook's effect (see useOverlayHistory.js).
 */
function fakeAsyncHistory(initial = { idx: 3, key: 'k' }) {
  const stack = [initial]; const listeners = new Set();
  let pendingBacks = 0;
  return {
    history: {
      get state() { return stack[stack.length - 1]; },
      pushState(state) { stack.push(state); },
      back() { pendingBacks += 1; },
    },
    listen: (fn) => listeners.add(fn), unlisten: (fn) => listeners.delete(fn),
    stack,
    get pendingBacks() { return pendingBacks; },
    flushOneBack() {
      if (pendingBacks === 0) return;
      pendingBacks -= 1;
      stack.pop();
      listeners.forEach(fn => fn());
    },
  };
}

/**
 * The callback an owner arms the hook with, extracted by name rather than by
 * pinning its text: `useOverlayHistory(open, <name>, tag)` → the body of
 * `const <name> = useCallback(() => { … }, [])`.
 */
function armedWith(code, callPattern) {
  const call = code.match(callPattern);
  assert.ok(call, `no useOverlayHistory call matching ${callPattern}`);
  const name = call[1];
  const fn = code.match(new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[\\]\\)`));
  assert.ok(fn, `${name} debe ser un useCallback sin dependencias`);
  return { name, body: fn[1] };
}

test('abrir empuja una entrada que conserva idx y key; atrás cierra', () => {
  const f = fakeHistory(); let closed = 0;
  const ctl = createOverlayHistory(f);
  ctl.arm('reader', () => { closed += 1; });
  assert.deepEqual(f.stack.at(-1), { idx: 3, key: 'k', overlay: 'reader' });
  f.history.back();
  assert.equal(closed, 1);
  assert.equal(f.stack.length, 1);
});

test('cerrar con la X retira la entrada sin cerrar dos veces', () => {
  const f = fakeHistory(); let closed = 0;
  const ctl = createOverlayHistory(f);
  ctl.arm('pdf', () => { closed += 1; });
  ctl.disarm();
  assert.equal(f.stack.length, 1);
  assert.equal(closed, 0);
});

test('abrir y cerrar con la X tres veces no acumula entradas', () => {
  const f = fakeHistory(); let closed = 0;
  const ctl = createOverlayHistory(f);
  for (let i = 0; i < 3; i += 1) {
    ctl.arm('reader', () => { closed += 1; });
    assert.equal(f.stack.length, 2, `abrir #${i + 1} empuja exactamente una entrada`);
    ctl.disarm();
    assert.equal(f.stack.length, 1, `cerrar #${i + 1} la retira: la pila vuelve a 1, no se acumula una entrada por apertura`);
  }
  assert.equal(closed, 0, 'cerrar con la X nunca pasa por onClose');
});

test('abrir y volver con Atrás tres veces no acumula entradas', () => {
  const f = fakeHistory(); let closed = 0;
  const ctl = createOverlayHistory(f);
  for (let i = 0; i < 3; i += 1) {
    ctl.arm('reader', () => { closed += 1; });
    assert.equal(f.stack.length, 2, `abrir #${i + 1} empuja exactamente una entrada`);
    f.history.back();
    assert.equal(f.stack.length, 1, `Atrás #${i + 1} la retira: la pila vuelve a 1, no se acumula una entrada por apertura`);
  }
  assert.equal(closed, 3, 'cada Atrás cierra exactamente una vez');
});

test('arm() no hace nada si ya está armado', () => {
  const f = fakeHistory();
  const ctl = createOverlayHistory(f);
  ctl.arm('reader', () => {});
  ctl.arm('reader', () => {});
  assert.equal(f.stack.length, 2, 'un segundo arm() mientras el primero sigue en pie no empuja otra entrada');
});

test('rearmar antes de que el back() en curso se resuelva no duplica la entrada', () => {
  // Models createOverlayHistory's OWN defence (the `alreadyOnTag` check in
  // arm()), independent of the extra `requestAnimationFrame` guard
  // useOverlayHistory adds on top of it for the StrictMode case — this is
  // the pure function, called directly, the way the two tests above do.
  const f = fakeAsyncHistory();
  const ctl = createOverlayHistory(f);
  let closed = 0;
  const onClose = () => { closed += 1; };

  ctl.arm('reader', onClose);
  assert.equal(f.stack.length, 2, 'first arm pushes the overlay entry');

  ctl.disarm();
  assert.equal(f.stack.length, 2, 'the queued back has not resolved yet');

  ctl.arm('reader', onClose);
  assert.equal(f.stack.length, 2, 'still sitting on the same tagged entry: nothing new is pushed');

  f.flushOneBack();
  assert.equal(f.stack.length, 1, 'exactly one entry is removed — the one real push, not two');
  assert.equal(closed, 1, 'the still-armed overlay is told to close when its entry is actually gone');
});

test('desarmar con una entrada ajena encima no toca la pila', () => {
  // The branch this pins: `if (history.state?.overlay === tag)` in disarm().
  // Neither double models it above, so deleting that line left all ten of the
  // original tests green. The reachable route to it is a REAL navigation taken
  // while an overlay is armed — the `/` shortcut was one until searchShortcut.js
  // gated it — which pushes idx k+1 on top and unmounts the overlay with it.
  // Without the guard, that unmount's disarm() steps back over the navigation
  // the visitor just made.
  const f = fakeAsyncHistory();
  const ctl = createOverlayHistory(f);
  let closed = 0;
  ctl.arm('reader', () => { closed += 1; });
  assert.deepEqual(f.stack.at(-1), { idx: 3, key: 'k', overlay: 'reader' });

  f.history.pushState({ idx: 4, key: 'k2' });
  assert.equal(f.stack.length, 3, 'the real navigation is on top now');

  ctl.disarm();
  assert.equal(f.pendingBacks, 0, 'no back() may be queued: the entry on top is not ours');
  assert.deepEqual(f.stack.at(-1), { idx: 4, key: 'k2' }, 'the real entry stays put');
  assert.equal(f.stack.length, 3, 'and nothing is removed');
  assert.equal(closed, 0, 'nor is the overlay told to close: it is already gone');
});

test('un pushState que revienta no arma nada (SecurityError de Safari)', () => {
  const f = fakeHistory();
  const ctl = createOverlayHistory(f);
  f.history.pushState = () => { throw new Error('SecurityError: too many pushes'); };
  let closed = 0;

  assert.doesNotThrow(() => ctl.arm('reader', () => { closed += 1; }), 'the throw must not escape the rAF callback');
  assert.equal(f.stack.length, 1, 'there is no new entry');

  ctl.disarm();
  assert.equal(f.stack.length, 1, 'and disarming must not retire the one that was already there');

  f.history.back();
  assert.equal(closed, 0, 'nothing was armed, so a later Back is not read as an overlay close');
});

test('el marcador que sobrevive a una recarga se limpia al arrancar', () => {
  const f = fakeHistory({ idx: 3, key: 'k', overlay: 'reader' });
  const cleared = clearStaleOverlayMarker({ history: f.history, location: { href: 'https://papertok.app/#/' } });

  assert.equal(cleared, true);
  assert.deepEqual(f.stack.at(-1), { idx: 3, key: 'k' }, 'el idx y la key de react-router se quedan; solo se va el marcador');
  assert.equal(f.stack.length, 1, 'limpiar no navega: la entrada duplicada sigue ahí, y retirarla costaría una recarga entera');

  // What the lie cost: `alreadyOnTag` would have seen its own tag on an entry
  // it never pushed, and el siguiente cierre habría retrocedido sobre ella.
  const ctl = createOverlayHistory(f);
  ctl.arm('reader', () => {});
  assert.equal(f.stack.length, 2, 'con el marcador limpio, armar vuelve a empujar su propia entrada');
});

test('un arranque normal no toca el historial', () => {
  const f = fakeHistory();
  let replaced = 0;
  f.history.replaceState = () => { replaced += 1; };

  assert.equal(clearStaleOverlayMarker({ history: f.history, location: { href: 'https://papertok.app/#/' } }), false);
  assert.equal(replaced, 0, 'sin marcador no se reescribe nada');
  assert.deepEqual(f.stack, [{ idx: 3, key: 'k' }]);
  assert.equal(clearStaleOverlayMarker({ history: { state: null }, location: null }), false, 'ni con un state vacío');
});

test('SOURCE: main.jsx limpia el marcador antes de renderizar', async () => {
  const code = stripComments(await read('../main.jsx'));
  assert.match(code, /import \{ clearStaleOverlayMarker \} from '\.\/hooks\/useOverlayHistory\.js'/);
  const callAt = code.indexOf('clearStaleOverlayMarker({');
  const renderAt = code.indexOf('ReactDOM.createRoot');
  assert.ok(callAt > -1, 'main.jsx tiene que llamarlo');
  assert.ok(renderAt > callAt, 'y antes de renderizar, cuando todavía no puede haber nada armado');
});

test('SOURCE: useOverlayHistory arma en el frame siguiente y cancela en la limpieza', async () => {
  const code = stripComments(await read('./useOverlayHistory.js'));
  const hookBody = code.match(/export function useOverlayHistory\(open, onClose, tag\) \{[\s\S]*?\n\}/);
  assert.ok(hookBody, 'useOverlayHistory must still have this exact signature');
  const body = hookBody[0];
  // The names and the whitespace are nobody's business — the ORDER is: the
  // arm is deferred a frame, and the cleanup cancels that frame (before it
  // disarms), so StrictMode's synchronous dev-only remount cancels the first
  // arm instead of racing its disarm.
  const armedAt = body.indexOf('requestAnimationFrame');
  const cancelledAt = body.indexOf('cancelAnimationFrame');
  assert.ok(armedAt > -1, 'arming must still be deferred with requestAnimationFrame');
  assert.ok(cancelledAt > armedAt, 'cleanup must cancel that frame with cancelAnimationFrame');
  assert.ok(
    body.indexOf('ctl.disarm()') > cancelledAt,
    'the cancel has to come before the disarm, or the pending arm outlives it',
  );
});

test('SOURCE: el lector de PaperCard usa useOverlayHistory con el tag reader', async () => {
  const code = stripComments(await read('../components/Feed/PaperCard.jsx'));
  assert.match(
    code,
    /import \{ useOverlayHistory \} from '\.\.\/\.\.\/hooks\/useOverlayHistory\.js';/,
    'must import the hook',
  );
  assert.match(code, /const \[showReader, setShowReader\] = useState\(false\);/);
  const { body } = armedWith(code, /useOverlayHistory\(showReader, (\w+), 'reader'\)/);
  assert.match(body, /readerCloseRef\.current\(\)/, 'Atrás tiene que PEDIR el cierre al lector, no desmontarlo');
  assert.match(body, /setShowReader\(false\)/, 'con el desmontaje solo como respaldo mientras el chunk perezoso no ha montado');
  assert.match(code, /closeRef=\{readerCloseRef\}/, 'y el lector tiene que recibir ese mismo ref');
});

test('SOURCE: el visor de PDF de App usa useOverlayHistory con el tag pdf', async () => {
  const code = stripComments(await read('../App.jsx'));
  assert.match(
    code,
    /import \{ useOverlayHistory \} from '\.\/hooks\/useOverlayHistory\.js'/,
    'must import the hook',
  );
  assert.match(code, /const \[pdfPaper, setPdfPaper\] = useState\(null\)/);
  const { body: armedBody } = armedWith(code, /useOverlayHistory\(Boolean\(pdfPaper\), (\w+), 'pdf'\)/);
  assert.match(armedBody, /pdfCloseRef\.current\(\)/, 'Atrás tiene que PEDIR el cierre al visor, no desmontarlo');
  assert.match(armedBody, /setPdfPaper\(null\)/, 'con el desmontaje solo como respaldo mientras el chunk perezoso no ha montado');
  assert.match(code, /<PDFViewer paper=\{pdfPaper\} closeRef=\{pdfCloseRef\}/, 'y el visor tiene que recibir ese mismo ref');

  // Critical point 3: on a coarse pointer, openPdf hands off to a new tab and
  // returns WITHOUT touching pdfPaper — it must arm nothing. Pin that the
  // early return still precedes the only setPdfPaper call in the function.
  const openPdfBody = code.match(/const openPdf = useCallback\(\(paper\) => \{[\s\S]*?\n {2}\}, \[\]\)/);
  assert.ok(openPdfBody, 'openPdf must still have this shape');
  const body = openPdfBody[0];
  const setCalls = body.match(/setPdfPaper\(/g) || [];
  assert.equal(setCalls.length, 1, 'openPdf must call setPdfPaper exactly once');
  const returnIndex = body.indexOf('if (url && window.open(url, \'_blank\', \'noopener\')) return');
  const setIndex = body.indexOf('setPdfPaper(');
  assert.ok(returnIndex > -1 && setIndex > returnIndex, 'the coarse-pointer hand-off must return before setPdfPaper is ever reached');
});

test('SOURCE: el visor de PDF propio de EntityExplorer usa useOverlayHistory con el tag pdf', async () => {
  const code = stripComments(await read('../components/Explorer/EntityExplorer.jsx'));
  assert.match(
    code,
    /import \{ useOverlayHistory \} from '\.\.\/\.\.\/hooks\/useOverlayHistory\.js';/,
    'must import the hook',
  );
  assert.match(code, /const \[pdfPaperToView, setPdfPaperToView\] = useState\(null\);/);
  const { body } = armedWith(code, /useOverlayHistory\(Boolean\(pdfPaperToView\), (\w+), 'pdf'\)/);
  assert.match(body, /pdfCloseRef\.current\(\)/, 'Atrás tiene que PEDIR el cierre al visor, no desmontarlo');
  assert.match(body, /setPdfPaperToView\(null\)/, 'con el desmontaje solo como respaldo mientras el chunk perezoso no ha montado');
  assert.match(code, /<PDFViewer paper=\{pdfPaperToView\} closeRef=\{pdfCloseRef\}/, 'y el visor tiene que recibir ese mismo ref');
});

test('SOURCE: el visor de PDF propio de SearchPage usa useOverlayHistory con el tag pdf', async () => {
  // A fourth owner, missed by the original three-owner pass (the reader in
  // PaperCard, App's shared viewer, EntityExplorer's own): SearchPage mounts
  // its own `<PDFViewer>` for a paper opened from a search result, with the
  // same shape as EntityExplorer's. It shares the 'pdf' tag rather than
  // taking its own: the tag only dedupes against the one shared
  // `window.history.state`, and these owners are mutually exclusive the same
  // way App's and EntityExplorer's already are — each PDFViewer is a modal
  // that makes the rest of the page inert while it is open, so no two of the
  // four can ever be mounted at once for this to collide against.
  const code = stripComments(await read('../components/Search/SearchPage.jsx'));
  assert.match(
    code,
    /import \{ useOverlayHistory \} from '\.\.\/\.\.\/hooks\/useOverlayHistory\.js';/,
    'must import the hook',
  );
  assert.match(code, /const \[pdfPaper, setPdfPaper\] = useState\(null\);/);
  const { body } = armedWith(code, /useOverlayHistory\(Boolean\(pdfPaper\), (\w+), 'pdf'\)/);
  assert.match(body, /pdfCloseRef\.current\(\)/, 'Atrás tiene que PEDIR el cierre al visor, no desmontarlo');
  assert.match(body, /setPdfPaper\(null\)/, 'con el desmontaje solo como respaldo mientras el chunk perezoso no ha montado');
  assert.match(code, /<PDFViewer paper=\{pdfPaper\} closeRef=\{pdfCloseRef\}/, 'y el visor tiene que recibir ese mismo ref');
});

const SRC_DIR = new URL('../', import.meta.url);

/**
 * Every `.js`/`.jsx` under src/ except the tests, path-relative — same shape
 * as `accessibilityStructure.test.js`'s `sources()`.
 */
async function sourceFilesUnderSrc() {
  const entries = await readdir(SRC_DIR, { recursive: true });
  return entries.filter((name) => /\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)).sort();
}

/**
 * The four SOURCE tests above pin exactly today's owners — three
 * `<PDFViewer>` mounts and one `<PaperReader>` — by matching each one's file
 * by name. That pins the past; it does nothing for a FIFTH mount added later
 * anywhere else under src/, which is exactly how SearchPage's own
 * `<PDFViewer>` went unwired to this hook until someone noticed by hand (see
 * the SOURCE test above this one). This test is the net under the per-file
 * ones: it does not know the owners' names, only the shape — any file that
 * renders `<PDFViewer` or `<PaperReader` has to also reference
 * `useOverlayHistory`, or Back would leave PaperTok through it exactly as it
 * did before this hook existed. `.test.js` files are excluded on purpose:
 * this file's own SOURCE tests above quote `<PDFViewer …>` inside regex
 * literals, which would otherwise register as a mount of nothing.
 */
test('SOURCE: todo archivo bajo src/ que monta <PDFViewer o <PaperReader usa useOverlayHistory', async (t) => {
  const matched = [];
  const offenders = [];
  for (const file of await sourceFilesUnderSrc()) {
    const code = stripComments(await readFile(new URL(file, SRC_DIR), 'utf8'));
    if (!/<PDFViewer\b|<PaperReader\b/.test(code)) continue;
    matched.push(file);
    if (!/\buseOverlayHistory\b/.test(code)) offenders.push(file);
  }
  t.diagnostic(`archivos que montan <PDFViewer o <PaperReader: ${matched.join(', ') || '(ninguno)'}`);
  assert.ok(
    matched.length >= 4,
    'el rastreo bajo src/ no encontró ni siquiera los cuatro dueños conocidos '
    + '(App.jsx, EntityExplorer.jsx, SearchPage.jsx, PaperCard.jsx) — antes de '
    + 'confiar en un resultado vacío o corto, revisa el patrón o el directorio: '
    + `encontrados ${JSON.stringify(matched)}`,
  );
  assert.deepEqual(
    offenders,
    [],
    'estos archivos bajo src/ montan <PDFViewer o <PaperReader sin referenciar '
    + 'useOverlayHistory, así que Atrás los sacaría de PaperTok en vez de '
    + `cerrarlos — añádeles useOverlayHistory(open, onClose, tag): ${offenders.join(', ')}`,
  );
});

/**
 * Back and the X have to end in the SAME function. There is no DOM in this
 * suite (node:test, no jsdom), so this is read off the source rather than
 * exercised: the name each overlay publishes through `useImperativeHandle`
 * into the owner's `closeRef` — which is what the owner arms
 * `useOverlayHistory` with — compared against the name its own
 * `onOpenChange(false)` calls, the one the X and Escape travel through.
 */
const publishedClose = (code) => code.match(/useImperativeHandle\(closeRef, \(\) => (\w+),/)?.[1];
const dialogClose = (code) => code.match(/onOpenChange=\{\((\w+)\) => \{ if \(!\1\) (\w+)\(\); \}\}/)?.[2];

test('SOURCE: en el lector, Atrás y la X terminan en la misma función', async () => {
  const code = stripComments(await read('../components/Reader/PaperReader.jsx'));
  const published = publishedClose(code);
  const dialog = dialogClose(code);
  assert.ok(published, 'PaperReader tiene que publicar su cierre en closeRef');
  assert.ok(dialog, 'y seguir cerrando por onOpenChange');
  assert.equal(published, dialog, 'Atrás y la X tienen que pasar por la misma función');
  assert.match(code, new RegExp(`onClick=\\{${dialog}\\}`), 'la X llama a esa misma función');
  assert.match(
    code,
    /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/,
    'y el padre se entera solo cuando la salida ha terminado: por eso Atrás no puede desmontar',
  );
});

test('SOURCE: en el visor de PDF, Atrás y la X terminan en la misma función', async () => {
  const code = stripComments(await read('../components/PDF/PDFViewer.jsx'));
  const published = publishedClose(code);
  const dialog = dialogClose(code);
  assert.ok(published, 'PDFViewer tiene que publicar su cierre en closeRef');
  assert.ok(dialog, 'y seguir cerrando por onOpenChange');
  assert.equal(published, dialog, 'Atrás y la X tienen que pasar por la misma función');
  assert.match(
    code,
    /onOpenChangeComplete=\{\(nextOpen\) => \{ if \(!nextOpen\) onClose\(\); \}\}/,
    'y el padre se entera solo cuando la salida ha terminado',
  );
});
