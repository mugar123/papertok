import { createElement, lazy, useRef } from 'react';

/**
 * `React.lazy` with a `preload()` that actually spares the first render.
 *
 * Prefetching a chunk with a bare `import()` warms the module cache but not
 * the lazy component: its first render still calls the factory, receives a
 * promise, and suspends until that promise's callbacks run — a microtask
 * later, but a suspension all the same. Under `AnimatePresence mode="wait"`
 * that first render happens right after the outgoing page finishes leaving,
 * outside the router's transition, so React commits the Suspense fallback and
 * then holds it for its 300 ms fallback throttle: a blank beat between exit
 * and entrance the first time each screen is opened, chunk cached or not.
 *
 * The overlays pay the same toll without any presence wrapper: the comments
 * sheet, opened the first time in a session, appeared ~420 ms after the tap
 * (measured, chunk cached), because its `Suspense fallback={null}` is still a
 * fallback React commits and then holds for the throttle. Preloaded, it
 * appears on the next frame.
 *
 * Once `preload()` has resolved, the component renders the module directly
 * and never suspends. A cold visit (nothing preloaded) still goes through the
 * ordinary lazy path and the fallback, exactly as before.
 */
export function lazyWithPreload(factory) {
  let loaded = null;
  let pending = null;
  const load = () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(factory)
        .then((module) => {
          loaded = module.default;
          return module;
        }, (error) => {
          pending = null;
          throw error;
        });
    }
    return pending;
  };
  const Lazy = lazy(load);

  function Preloadable(props) {
    // An instance that first rendered through `Lazy` keeps doing so: swapping
    // the element type once the module lands would remount the screen and
    // lose its state. After resolution `Lazy` renders synchronously anyway.
    const viaLazy = useRef(loaded === null);
    return createElement(viaLazy.current ? Lazy : loaded, props);
  }
  Preloadable.preload = load;
  return Preloadable;
}
