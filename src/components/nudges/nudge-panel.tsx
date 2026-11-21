import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Transition } from 'framer-motion';
interface NudgePanelProps {
  icon: ReactNode; title: string; body: ReactNode;
  action: { label: string; onClick: () => void };
  dismissLabel?: string; onDismiss?: () => void;
}
import { motion, useReducedMotion } from 'framer-motion';
import { X } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { EASE_OUT, EASE_OUT_EXPO } from '../../utils/motion-curves.ts';
import { nudgeEdge } from '../../utils/nudges.ts';
import './nudge-panel.css';

// An aside, not a dialog: it takes no focus, traps nothing, and covers no
// control. Someone reading a paper can ignore it to the end of the page, and
// the X is the only thing it asks for.
//
// The motion, measured on its twin (2026-09-12): opacity runs straight and
// lands first, movement keeps easing underneath it. One curve for all three
// values is not a fade, it is a flash with a tail — 90% opacity 90ms in with
// the travel still going.
const ARRIVAL: Transition = {
  opacity: { duration: 0.26, ease: 'linear' },
  y: { duration: 0.38, ease: EASE_OUT_EXPO },
  scale: { duration: 0.38, ease: EASE_OUT_EXPO },
};

// Leaving, the fade leads and is done at 180ms: the panel stops asking for the
// eye at once, and the sink finishes under something nobody is looking at.
// It sinks because it rose — the same path, backwards, on the strong
// ease-out every exit uses (2026-10-15), not an ease-in.
const LEAVE: Transition = {
  opacity: { duration: 0.18, ease: 'linear' },
  y: { duration: 0.22, ease: EASE_OUT },
  scale: { duration: 0.22, ease: EASE_OUT },
};

// The panel is fixed and reserves no room, and the feed's cards fill the
// screen, so on a small one it can sit over the control that has keyboard
// focus (WCAG 2.4.11). It moves instead of taking room from the feed, whose
// snap geometry is one card per screen: when the focused control would be
// under it at the bottom, it takes the top edge under the navbar. It only
// measures; focus is never moved. Checked as focus arrives and again a frame
// later, once the browser has scrolled the focused control into view, when the
// screen is resized and when the panel appears.
function useClearOfFocus() {
  const panel = useRef<HTMLElement>(null);
  const place = useEffectEvent(() => {
    const element = panel.current;
    const target = document.activeElement;
    if (!element) return;
    if (!target || target === document.body || element.contains(target)) {
      element.dataset.edge = 'bottom';
      return;
    }
    const box = (edge: 'bottom' | 'top') => {
      element.dataset.edge = edge;
      return element.getBoundingClientRect();
    };
    const atTop = box('top');
    const atBottom = box('bottom');
    element.dataset.edge = nudgeEdge({ target: target.getBoundingClientRect(), atBottom, atTop });
  });
  useLayoutEffect(() => place());
  useEffect(() => {
    let frame = 0;
    const onChange = () => place();
    // focusin fires before the browser scrolls the control into view.
    const onFocus = () => {
      place();
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => place());
    };
    document.addEventListener('focusin', onFocus);
    window.addEventListener('resize', onChange);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('resize', onChange);
    };
  }, []);
  return panel;
}

export default function NudgePanel({
  icon,
  title,
  body,
  action,
  dismissLabel,
  onDismiss,
}: NudgePanelProps) {
  const prefersReducedMotion = useReducedMotion();
  const panel = useClearOfFocus();

  return (
    <motion.aside
      ref={panel}
      className="nudge"
      aria-labelledby="nudge-title"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98, transition: LEAVE }}
      transition={prefersReducedMotion ? { duration: 0 } : ARRIVAL}
    >
      <span className="nudge-icon" aria-hidden="true">{icon}</span>
      <div className="nudge-copy">
        <h2 id="nudge-title">{title}</h2>
        <p>{body}</p>
      </div>
      <div className="nudge-actions">
        <Button size="sm" className="nudge-action" onClick={action.onClick}>{action.label}</Button>
      </div>
      {onDismiss && (
        <button
          type="button"
          className="nudge-dismiss"
          onClick={onDismiss}
          aria-label={dismissLabel}
          title={dismissLabel}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </motion.aside>
  );
}
