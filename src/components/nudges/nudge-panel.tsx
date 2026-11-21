import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
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
import { createNudgePlacer, type Placement } from '../../utils/nudge-placement.ts';
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
// top edge under the navbar when the bottom would cover the control, and its
// compact form (title, Show, dismiss) when both would, as with enlarged text.
// Here it only measures and applies; focus is never moved to make room.
// Checked as focus arrives and again a frame later, once the browser has
// scrolled the focused control into view, when the screen is resized and when
// the panel appears. Not while focus is inside the panel or a pointer press
// is down.
function useClearOfFocus() {
  const panel = useRef<HTMLElement>(null);
  const placer = useRef<ReturnType<typeof createNudgePlacer> | null>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    const put = ({ edge, compact }: Placement) => {
      element.dataset.edge = edge;
      if (compact) element.dataset.compact = '';
      else delete element.dataset.compact;
    };
    const next = createNudgePlacer({
      focus: () => {
        const target = document.activeElement;
        if (!target || target === document.body) return { kind: 'none' };
        if (element.contains(target)) return { kind: 'inside' };
        return { kind: 'control', box: target.getBoundingClientRect() };
      },
      measure: (placement) => {
        put(placement);
        return element.getBoundingClientRect();
      },
      apply: put,
    });
    placer.current = next;
    next.place();
    let frame = 0;
    const onPlace = () => next.place();
    // focusin fires before the browser scrolls the control into view.
    const onFocus = () => {
      next.place();
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(onPlace);
    };
    const onDown = (event: PointerEvent) => next.pointerDown(event.pointerId);
    const onUp = (event: PointerEvent) => next.pointerUp(event.pointerId);
    // A press whose release never arrives must not hold the panel for good.
    const onReleaseAll = () => next.releaseAll();
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    window.addEventListener('resize', onPlace);
    window.addEventListener('blur', onReleaseAll);
    document.addEventListener('contextmenu', onReleaseAll, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('resize', onPlace);
      window.removeEventListener('blur', onReleaseAll);
      document.removeEventListener('contextmenu', onReleaseAll, true);
      placer.current = null;
    };
  }, []);
  // The reader asked for the full panel: it opens in place and focus goes to its action.
  const expand = useCallback(() => {
    placer.current?.expand();
    panel.current?.querySelector<HTMLElement>('.nudge-action')?.focus();
  }, []);
  return { panel, expand };
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
  const { panel, expand } = useClearOfFocus();

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
      {/* Shown only in the compact form (nudge-panel.css). */}
      <Button variant="outline" size="sm" className="nudge-show" aria-label="Show notice" onClick={expand}>Show</Button>
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
