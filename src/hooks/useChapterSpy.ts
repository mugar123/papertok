import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

export default function useChapterSpy(scrollRef: RefObject<HTMLElement | null>, count: number) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || count === 0) return undefined;
    const update = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
      const chapters = scroller.querySelectorAll('[data-chapter]');
      let current = 0;
      chapters.forEach((chapter, index) => {
        if (chapter.getBoundingClientRect().top <= line) current = index;
      });
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = chapters.length - 1;
      setActive(Math.max(0, current));
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [scrollRef, count]);
  return active;
}
