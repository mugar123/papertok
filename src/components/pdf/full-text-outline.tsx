import type { MouseEvent } from 'react';
import type { Outline } from './use-outline.ts';
import { useEffect, useRef, useState } from 'react';
import { landOn } from './article-places.ts';

function useActiveInView(list: HTMLElement | null, active: number) {
  useEffect(() => {
    if (!list) return;
    const frame = requestAnimationFrame(() => {
      const link = list.querySelector<HTMLElement>('[aria-current="location"]');
      if (link) list.scrollTop = link.offsetTop - list.clientHeight / 2 + link.offsetHeight / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [list, active]);
}

export function OutlineList({ items, active, onPick }: Outline & { onPick?: () => void }) {
  const jump = (event: MouseEvent, target: string) => {
    event.preventDefault();
    onPick?.();
    const heading = document.getElementById(target);
    if (heading) landOn(heading, 'start');
  };
  return (
    <ol className="ft-outline-list">
      {items.map((item, index) => (
        <li key={item.target} data-depth={item.depth}>
          <a href={`#${item.target}`} title={item.title} aria-current={index === active ? 'location' : undefined} onClick={event => jump(event, item.target)}>
            <span className="ft-outline-title">{item.title}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

export function OutlineRail(outline: Outline) {
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement | null>(null);
  const pointer = useRef('');
  const [list, setList] = useState<HTMLDivElement | null>(null);
  useActiveInView(open ? list : null, outline.active);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!nav.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  if (outline.items.length === 0) return null;
  return (
    <nav
      ref={nav}
      className="ft-rail"
      aria-label="Contents"
      data-open={open || undefined}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    >
      <button
        type="button"
        className="ft-rail-ticks"
        aria-expanded={open}
        aria-label="Show the contents"
        onPointerDown={event => { pointer.current = event.pointerType; }}
        onClick={() => {
          // A mouse has already opened it by hovering; a tap or a key toggles it.
          if (pointer.current !== 'mouse') setOpen(value => !value);
          pointer.current = '';
        }}
      >
        {outline.items.map((item, index) => (
          <span key={item.target} className="ft-rail-tick" data-depth={item.depth} data-active={index === outline.active || undefined} />
        ))}
      </button>
      <div className="ft-rail-panel ft-outline-scroll" ref={setList}>
        <OutlineList {...outline} onPick={() => setOpen(false)} />
      </div>
    </nav>
  );
}
