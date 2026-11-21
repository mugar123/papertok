import { useLayoutEffect, useRef, type ReactNode } from 'react';
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
import { bindNudgePlacement, clipToViewport, createNudgePlacer, type Placement } from '../../utils/nudge-placement.ts';
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
// focus (WCAG 2.4.11). utils/nudge-placement.ts decides where it goes: the
// top edge under the navbar when the bottom would cover the control, and
// hidden (inert, so nothing in it takes focus) while both would cover it
// entirely, as with enlarged text. Here it only measures and applies. Focus is
// never moved, and the notice is never dismissed: it comes back when focus
// moves to a control it does not cover. Checked as focus arrives, as anything
// scrolls and when the screen is resized; not while focus is inside the panel
// or a pointer press is down.
function useClearOfFocus() {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    const put = ({ edge, hidden }: Placement) => {
      element.dataset.edge = edge;
      if (hidden) element.dataset.hidden = '';
      else delete element.dataset.hidden;
      element.inert = hidden;
    };
    const placer = createNudgePlacer({
      focus: () => {
        const target = document.activeElement;
        if (!target || target === document.body) return { kind: 'none' };
        if (element.contains(target)) return { kind: 'inside' };
        // Only what is on screen counts: a tall control is hidden when what shows of it is covered.
        return { kind: 'control', box: clipToViewport(target.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }) };
      },
      measure: (edge) => {
        element.dataset.edge = edge;
        return element.getBoundingClientRect();
      },
      apply: put,
    });
    placer.place();
    return bindNudgePlacement(placer, {
      doc: document,
      win: window,
      requestFrame: callback => window.requestAnimationFrame(callback),
      cancelFrame: frame => window.cancelAnimationFrame(frame),
    });
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
