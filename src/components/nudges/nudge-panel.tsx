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
import { bindNudgePlacement, clipToViewport, createNudgePlacer, restoreTarget, type Placement } from '../../utils/nudge-placement.ts';
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

// What tells the placement that layout may have changed under a focused
// control. No single cheap signal reports a control moving, so this listens to
// the ones that cause it. Size: the page and the panel itself (a text-size
// change, a long word wrapping, the window) and the fonts loading. Content: any
// change to the page's elements or to the attributes that lay them out (a
// section opening, a class, a style), a transition or animation that ends, an
// image that loads. Changes inside the panel are ignored: the placement writes
// there itself. Each only asks for a decision a frame later; a content notice
// is dropped unless a control of the page has focus (placeForContent), and a
// size notice always decides. Not a per-frame poll: that would run for as long
// as any control has focus.
function watchLayout(panel: HTMLElement, notify: { size: () => void; content: () => void }) {
  const mutations = new MutationObserver((records) => {
    if (records.some(record => !panel.contains(record.target))) notify.content();
  });
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden'] });
  const resizes = new ResizeObserver(() => notify.size());
  resizes.observe(panel);
  resizes.observe(document.documentElement);
  const content = () => notify.content();
  const events = ['transitionend', 'animationend', 'load'];
  events.forEach(type => document.addEventListener(type, content, true));
  // loadingdone is sent to the font set, not to the document.
  const fonts = document.fonts;
  const fontsLoaded = () => notify.size();
  fonts?.addEventListener('loadingdone', fontsLoaded);
  return () => {
    mutations.disconnect();
    resizes.disconnect();
    events.forEach(type => document.removeEventListener(type, content, true));
    fonts?.removeEventListener('loadingdone', fontsLoaded);
  };
}

// The panel is fixed and reserves no room, and the feed's cards fill the
// screen, so on a small one it can sit over the control that has keyboard
// focus (WCAG 2.4.11). utils/nudge-placement.ts decides where it goes: the
// top edge under the navbar when the bottom would cover the control, and
// hidden (inert, so nothing in it takes focus) while both would cover it
// entirely, as with enlarged text. Here it only measures and applies. Focus is
// never moved to make room, and the notice is never dismissed: it comes back
// when focus moves to a control it does not cover. It is hidden too when it
// does not fit on screen at all; if focus is inside it then, focus goes back
// to the control it came from first. Checked as focus arrives, as anything scrolls, when the
// screen is resized and when the layout changes (watchLayout); a pointer press
// holds it, and focus inside it keeps its edge.
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
        return { kind: 'control', box: clipToViewport(target.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }), ref: target };
      },
      // The panel is about to be hidden with focus inside it: back to the control focus came from, or when that is gone
      // (or focus was never on one) to the page container, where a route change leaves it. The indicator shows because
      // focus was already visible there; `focusVisible` asks for it where the browser supports the option.
      restoreFocus: (origin) => {
        const container = () => document.getElementById('main-content');
        const back = restoreTarget<HTMLElement>(origin instanceof HTMLElement ? origin : undefined, {
          usable: candidate => candidate.isConnected,
          fallback: container,
        });
        back?.focus({ focusVisible: true });
        // A control that is disabled, not displayed or inert does not take focus: it is still in the panel, which
        // is about to go inert, so try the page container before focus is dropped to the body.
        if (element.contains(document.activeElement)) container()?.focus({ focusVisible: true });
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
      observeLayout: notify => watchLayout(element, notify),
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
