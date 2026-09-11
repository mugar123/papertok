import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOverlayHistory } from './useOverlayHistory.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * A history whose `back()` pops and notifies synchronously — good enough for
 * the cases below where nothing else touches history between an arm/disarm
 * pair and the assertion that follows it.
 */
function fakeHistory(initial = { idx: 3, key: 'k' }) {
  const stack = [initial]; const listeners = new Set();
  return {
    history: {
      get state() { return stack[stack.length - 1]; },
      pushState(state) { stack.push(state); },
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
    flushOneBack() {
      if (pendingBacks === 0) return;
      pendingBacks -= 1;
      stack.pop();
      listeners.forEach(fn => fn());
    },
  };
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
    assert.equal(f.stack.length, 1, `cerrar #${i + 1} la retira; history.length no crece`);
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
    assert.equal(f.stack.length, 1, `Atrás #${i + 1} la retira; history.length no crece`);
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

test('SOURCE: useOverlayHistory arma en el frame siguiente y cancela en la limpieza', async () => {
  const code = stripComments(await read('./useOverlayHistory.js'));
  const hookBody = code.match(/export function useOverlayHistory\(open, onClose, tag\) \{[\s\S]*?\n\}/);
  assert.ok(hookBody, 'useOverlayHistory must still have this exact signature');
  const body = hookBody[0];
  assert.match(
    body,
    /const frame = requestAnimationFrame\(\(\) => ctl\.arm\(tag, \(\) => closeRef\.current\(\)\)\);/,
    'arming is deferred a frame so StrictMode\'s synchronous dev-only remount cancels the first arm instead of racing its disarm',
  );
  assert.match(
    body,
    /cancelAnimationFrame\(frame\);\s*\n\s*ctl\.disarm\(\);/,
    'cleanup must cancel the pending frame before disarming, in that order',
  );
});

test('SOURCE: el lector de PaperCard usa useOverlayHistory con el tag reader', async () => {
  const code = stripComments(await read('../components/Feed/PaperCard.jsx'));
  assert.match(
    code,
    /import \{ useOverlayHistory \} from '\.\.\/\.\.\/hooks\/useOverlayHistory\.js';/,
    'must import the hook',
  );
  assert.match(
    code,
    /const \[showReader, setShowReader\] = useState\(false\);\s*\n\s*useOverlayHistory\(showReader, \(\) => setShowReader\(false\), 'reader'\);/,
    'the hook must be armed by showReader itself, right where it is declared',
  );
});

test('SOURCE: el visor de PDF de App usa useOverlayHistory con el tag pdf', async () => {
  const code = stripComments(await read('../App.jsx'));
  assert.match(
    code,
    /import \{ useOverlayHistory \} from '\.\/hooks\/useOverlayHistory\.js'/,
    'must import the hook',
  );
  assert.match(
    code,
    /const \[pdfPaper, setPdfPaper\] = useState\(null\)\s*\n\s*useOverlayHistory\(Boolean\(pdfPaper\), \(\) => setPdfPaper\(null\), 'pdf'\)/,
    'the hook must be armed by pdfPaper itself, right where it is declared',
  );

  // Critical point 3: on a coarse pointer, openPdf hands off to a new tab and
  // returns WITHOUT touching pdfPaper — it must arm nothing. Pin that the
  // early return still precedes the only setPdfPaper call in the function.
  const openPdfBody = code.match(/const openPdf = useCallback\(\(paper\) => \{[\s\S]*?\n {2}\}, \[\]\)/);
  assert.ok(openPdfBody, 'openPdf must still have this shape');
  const body = openPdfBody[0];
  const setCalls = body.match(/setPdfPaper\(/g) || [];
  assert.equal(setCalls.length, 1, 'setPdfPaper must be called at most once in openPdf');
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
  assert.match(
    code,
    /const \[pdfPaperToView, setPdfPaperToView\] = useState\(null\);\s*\n\s*useOverlayHistory\(Boolean\(pdfPaperToView\), \(\) => setPdfPaperToView\(null\), 'pdf'\);/,
    'the hook must be armed by pdfPaperToView itself, right where it is declared',
  );
});
