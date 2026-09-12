import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import './NudgePanel.css';

// The panel a nudge is shown in. It is deliberately the same object as the
// analytics banner — same corner, same surface, same arrival — because two
// panels that appear in one corner and move differently read as two different
// systems talking over each other.
//
// An aside, not a dialog: it takes no focus, traps nothing, and covers no
// control. Someone reading a paper can ignore it to the end of the page, and
// the X is the only thing it asks for.
//
// The motion, measured on its twin (2026-09-12): opacity runs straight and
// lands first, movement keeps easing underneath it. One curve for all three
// values is not a fade, it is a flash with a tail — 90% opacity 90ms in with
// the travel still going.
const ARRIVAL = {
  opacity: { duration: 0.26, ease: 'linear' },
  y: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
  scale: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
};

// Leaving, the fade leads and is done at 180ms: the panel stops asking for the
// eye at once, and the sink finishes under something nobody is looking at.
// It sinks because it rose — the same path, backwards.
const LEAVE = {
  opacity: { duration: 0.18, ease: 'linear' },
  y: { duration: 0.26, ease: [0.4, 0, 1, 1] },
  scale: { duration: 0.26, ease: [0.4, 0, 1, 1] },
};

export default function NudgePanel({
  icon,
  iconClassName = '',
  title,
  body,
  action,
  dismissLabel,
  onDismiss,
}) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.aside
      className="nudge"
      aria-labelledby="nudge-title"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98, transition: LEAVE }}
      transition={prefersReducedMotion ? { duration: 0 } : ARRIVAL}
    >
      <span className={`nudge-icon ${iconClassName}`} aria-hidden="true">{icon}</span>
      <div className="nudge-copy">
        <h2 id="nudge-title">{title}</h2>
        <p>{body}</p>
      </div>
      <div className="nudge-actions">
        {action.href ? (
          <Button
            size="sm"
            onClick={action.onClick}
            render={<a href={action.href} target="_blank" rel="noopener noreferrer" />}
          >
            {action.label}
          </Button>
        ) : (
          <Button size="sm" onClick={action.onClick}>{action.label}</Button>
        )}
      </div>
      <button
        type="button"
        className="nudge-dismiss"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </motion.aside>
  );
}
