import { useCallback, useEffect, useState } from 'react';

/**
 * The `open` state for a Base UI popup whose PARENT decides it exists.
 *
 * Base UI does not play an enter transition for a popup that is already open
 * on its first render. That is deliberate and it is right: `useTransitionStatus`
 * seeds `mounted` from `open`, so the `open && !mounted` branch — the one that
 * produces `transitionStatus: 'starting'`, and with it `data-starting-style` —
 * never runs, and a `defaultOpen` popup or SSR'd markup therefore does not
 * animate in on page load. The escape hatch is a fourth argument,
 * `animateInitialOpen`, which is internal: only `MenuRoot` passes it, and no
 * Root component exposes it as a prop.
 *
 * This app mounts every sheet and dialog as `{thing && <Sheet />}` and lets the
 * sheet hold its own `open`, so "already open on the first render" is not the
 * edge case here — it is every popup in the app. The result is that they do
 * not arrive: they appear.
 *
 * Measured against the real primitive at 390x844. Mounted open, the popup sat
 * at its final transform from the first frame it existed and the backdrop was
 * at 0.4 in that same frame — no travel at all. Opened on the frame after
 * mount, it came 243px up over ~370ms with the backdrop fading in behind it.
 *
 * One frame is the whole trick: the popup does not exist on the first render,
 * so the primitive sees a real closed → open change and starts a transition.
 * Nothing hears about a close that has not happened — `onOpenChangeComplete`
 * is armed by `mounted && !open`, and `mounted` is false until the flip.
 *
 * Returns the flag to hand the Root and the closer to hand the UI. Closing is
 * still only a request: the parent should unmount on `onOpenChangeComplete`,
 * once the leave has actually played.
 */
export function usePopupOpenOnMount() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const requestClose = useCallback(() => setOpen(false), []);
  return { open, setOpen, requestClose };
}
