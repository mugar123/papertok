import test from 'node:test';
import assert from 'node:assert/strict';
import { clearStaleOverlayMarker, createOverlayHistory } from './use-overlay-history.ts';

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
  const stack = [initial]; const listeners = new Set<() => void>();
  return {
    history: {
      get state() { return stack[stack.length - 1]; },
      pushState(state: { idx: number; key: string; }) { stack.push(state); },
      replaceState(state: { idx: number; key: string; }) { stack[stack.length - 1] = state; },
      back() { stack.pop(); listeners.forEach(fn => fn()); },
    },
    listen: (fn: () => void) => listeners.add(fn), unlisten: (fn: () => void) => listeners.delete(fn),
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
 * mount does to this hook's effect (see use-overlay-history.ts).
 */
function fakeAsyncHistory(initial = { idx: 3, key: 'k' }) {
  const stack = [initial]; const listeners = new Set<() => void>();
  let pendingBacks = 0;
  return {
    history: {
      get state() { return stack[stack.length - 1]; },
      pushState(state: { idx: number; key: string; }) { stack.push(state); },
      back() { pendingBacks += 1; },
    },
    listen: (fn: () => void) => listeners.add(fn), unlisten: (fn: () => void) => listeners.delete(fn),
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
  // while an overlay is armed — the `/` shortcut was one until search-shortcut.ts
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
  const f = fakeHistory({ idx: 3, key: 'k', overlay: 'reader' } as NonNullable<Parameters<typeof fakeHistory>[0]> & Record<string, unknown>);
  const cleared = clearStaleOverlayMarker({ history: f.history, location: { href: 'https://papertok.app/feed' } });

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

  assert.equal(clearStaleOverlayMarker({ history: f.history, location: { href: 'https://papertok.app/feed' } }), false);
  assert.equal(replaced, 0, 'sin marcador no se reescribe nada');
  assert.deepEqual(f.stack, [{ idx: 3, key: 'k' }]);
  assert.equal(clearStaleOverlayMarker({ history: { state: null }, location: null }), false, 'ni con un state vacío');
});

test('un overlay encima de otro: cada Atrás cierra solo el de arriba, y la X del de arriba no cierra el de abajo', () => {
  const f = fakeHistory(); let layerClosed = 0; let readerClosed = 0;
  const layer = createOverlayHistory(f);
  const reader = createOverlayHistory(f);
  layer.arm('similar', () => { layerClosed += 1; });
  reader.arm('reader', () => { readerClosed += 1; });

  f.history.back();
  assert.equal(readerClosed, 1, 'el primer Atrás cierra el lector');
  assert.equal(layerClosed, 0, 'y la capa de debajo sigue abierta');

  f.history.back();
  assert.equal(layerClosed, 1, 'el segundo Atrás cierra la capa');
  assert.equal(f.stack.length, 1);

  layer.arm('similar', () => { layerClosed += 1; });
  reader.arm('reader', () => { readerClosed += 1; });
  reader.disarm();
  assert.equal(layerClosed, 1, 'cerrar el lector con la X no cierra la capa');
  assert.deepEqual(f.stack.at(-1), { idx: 3, key: 'k', overlay: 'similar' });
});
