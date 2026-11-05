import { useEffect, useEffectEvent } from 'react';

/** Runs `onFrame` at most once a frame while `element` scrolls, and not at all while it is null. */
export function useScrollFrame(element: HTMLElement | null, onFrame: () => void) {
  const frameEvent = useEffectEvent(onFrame);
  useEffect(() => {
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; frameEvent(); });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [element]);
}
