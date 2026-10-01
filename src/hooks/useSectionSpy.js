import { useEffect, useState } from 'react';

/** Select the first section in document order that intersects the reading band. */
export function useSectionSpy(sectionIds) {
  const [activeId, setActiveId] = useState(sectionIds[0]);

  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return undefined;
    const nodes = sectionIds
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (nodes.length === 0) return undefined;

    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = sectionIds.find(id => visible.has(id));
        // No band contact at all (between sections, or bounced past the end)
        // keeps the last answer rather than clearing the marker.
        if (first) setActiveId(first);
      },
      { rootMargin: '-96px 0px -62% 0px' },
    );
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}
