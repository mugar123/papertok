import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { STAR_PATH } from '../../utils/star-path.ts';

// The welcome's stars: one four-point glint at a time fades up, turns and fades
// out somewhere on the page, never over the hero. None starts after
// STARS_LAST_MS, so the sky is still within seconds (WCAG 2.2.2).
const STARS_LAST_MS = 2800;

export default function Stars({ avoid }: { avoid: RefObject<HTMLElement | null> }) {
  const sky = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let timer: number;
    const until = performance.now() + STARS_LAST_MS;
    const twinkle = () => {
      const delay = 500 + Math.random() * 1000;
      if (performance.now() + delay < until) timer = window.setTimeout(twinkle, delay);
      const box = sky.current?.getBoundingClientRect();
      const hero = avoid.current?.getBoundingClientRect();
      if (!box || !hero) return;
      let x;
      let y;
      let tries = 0;
      do {
        x = Math.random() * box.width;
        y = Math.random() * box.height;
        tries += 1;
      } while (tries < 8 && x > hero.left - box.left - 24 && x < hero.right - box.left + 24
        && y > hero.top - box.top - 24 && y < hero.bottom - box.top + 24);
      const size = 10 + Math.random() * 12;
      const star = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      star.setAttribute('viewBox', '0 0 24 24');
      if (Math.random() < 0.5) star.classList.add('is-spot');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', STAR_PATH);
      star.append(path);
      Object.assign(star.style, { left: `${x - size / 2}px`, top: `${y - size / 2}px`, width: `${size}px`, height: `${size}px` });
      sky.current!.append(star);
      star.animate([
        { opacity: 0, transform: 'scale(0.4) rotate(0deg)' },
        { opacity: 0.9, transform: 'scale(1) rotate(45deg)', offset: 0.4 },
        { opacity: 0, transform: 'scale(0.6) rotate(90deg)' },
      ], { duration: 1400 + Math.random() * 800, easing: 'ease-in-out' }).finished.then(() => star.remove(), () => star.remove());
    };
    timer = window.setTimeout(twinkle, 800);
    return () => window.clearTimeout(timer);
  }, [avoid]);
  return <div ref={sky} className="gw-stars" aria-hidden="true" />;
}
