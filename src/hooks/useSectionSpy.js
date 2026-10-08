import { useCallback, useEffect, useRef, useState } from 'react';

export function sectionForScrollProgress(nodes, {
  readingLine = 96,
  scrollTop = window.scrollY,
  viewportHeight = window.innerHeight,
  documentHeight = document.documentElement.scrollHeight,
} = {}) {
  if (nodes.length === 0) return undefined;
  const firstSectionTop = nodes[0].getBoundingClientRect().top + scrollTop;
  const start = Math.max(0, firstSectionTop - readingLine);
  const end = Math.max(start, documentHeight - viewportHeight);
  if (end === start) return nodes[0].id;
  const progress = Math.min(1, Math.max(0, (scrollTop - start) / (end - start)));
  return nodes[Math.min(nodes.length - 1, Math.floor(progress * nodes.length))].id;
}

/** Give every index entry its own interval in the page's scrollable journey. */
export function useSectionSpy(sectionIds) {
  const [activeId, setActiveId] = useState(sectionIds[0]);
  const navigationRef = useRef(false);
  const releaseTimerRef = useRef(0);

  const activateSection = useCallback((id) => {
    navigationRef.current = true;
    setActiveId(id);
    window.clearTimeout(releaseTimerRef.current);
    // Covers reduced-motion jumps, which may not emit a scroll event.
    releaseTimerRef.current = window.setTimeout(() => {
      navigationRef.current = false;
    }, 150);
  }, []);

  useEffect(() => {
    const nodes = sectionIds
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (nodes.length === 0) return undefined;

    let frame = 0;
    const update = () => {
      frame = 0;
      setActiveId(sectionForScrollProgress(nodes));
    };
    const scheduleUpdate = () => {
      if (navigationRef.current) {
        window.clearTimeout(releaseTimerRef.current);
        // Scroll events keep arriving throughout a smooth scroll. Release the
        // spy only after they settle, leaving the clicked entry selected.
        releaseTimerRef.current = window.setTimeout(() => {
          navigationRef.current = false;
        }, 150);
        return;
      }
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(releaseTimerRef.current);
    };
  }, [sectionIds]);

  return [activeId, activateSection];
}
