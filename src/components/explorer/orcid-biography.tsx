import { useId, useLayoutEffect, useRef } from 'react';

export default function OrcidBiography({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  const id = useId();
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const el = textRef.current;
    const button = buttonRef.current;
    if (!el || !button || expanded) return undefined;
    const measure = () => { button.hidden = el.scrollHeight <= el.clientHeight + 1; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <>
      <p id={id} ref={textRef} className={`orcid-biography${expanded ? '' : ' is-clamped'}`}>{text}</p>
      <button
        ref={buttonRef}
        type="button"
        className="project-show-more"
        onClick={() => {
          onToggle();
          if (expanded) requestAnimationFrame(() => buttonRef.current?.scrollIntoView({ block: 'nearest' }));
        }}
        aria-expanded={expanded}
        aria-controls={id}
      >
        {expanded ? 'Show less' : 'Read more'}
      </button>
    </>
  );
}
