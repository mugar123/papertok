import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, CaretDown, Check, SkipForward } from '@phosphor-icons/react';
import { CATEGORIES } from '../../data/categories.js';
import ThemeToggle from '../Layout/ThemeToggle.jsx';
import { Button } from '../ui/button.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './GuestWelcome.css';

// The welcome's page and its two pickers, shared by every flow drawn in the
// welcome's layout. The styles stay in GuestWelcome.css under `gw-*`.
//
// <WelcomeShell> draws, in order:
// - `<motion.main className="gw …">`, which fades up and out
//   while `leaving` and calls `onLeaveComplete` when that has finished. With
//   `still` there is no leave animation, so the caller hands its answer over
//   itself instead of waiting for `onLeaveComplete`.
// - `onStepShown(stepKey)` fires when the leaving screen has gone and the next
//   one mounts, with the key of the screen now shown: chrome that differs
//   between screens switches then, not while the old screen is still on its
//   way out (where it would shift it).
// - `landing` marks the landing page, the one screen whose bar may wear a
//   patterned (halftone) theme switch.
// - `backdrop`, drawn first and outside the stage: decoration placed against
//   the whole page, which a screen's own entrance must not carry with it.
// - The bar: the wordmark, the theme toggle and `barAction` after it.
// - The stage (`gw-stage`, plus `stageClassName`) with one `gw-step
//   gw-step--{stepKey}` section per screen. Changing `stepKey` slides the old
//   screen out and the new one in; `direction` is 1 forward and -1 back.
// - The foot: `dots` ({ count, index, label(n, total), ariaLabel, max? }) with the
//   current one marked `aria-current="step"`, then back, the primary button
//   ({ label, onClick, disabled, busy, form }) and skip. `busy` keeps the
//   button focusable but marks it `aria-disabled` while a save is in flight.
//   With `form` (a form's id) the button submits that form instead and needs
//   no `onClick`: the press is the form's own submit, a user gesture. `back`
//   and `skip` are `{ onClick, label }` or null; an absent one keeps its slot,
//   so the button never moves between screens.
//
// The caller renders each screen's content as `children`, starting with a
// <WelcomeCopy>. The shell moves focus to that heading whenever a new screen
// mounts, but not on first paint (see `focusNewHeading`).

const AREA_ENTRIES = Object.entries(CATEGORIES);

// The progress dots: a dot added grows in place with a light bounce, one taken
// away shrinks in place over the same time, no bounce; each waits DOT_STAGGER
// after its neighbour, so they come and go one at a time.
const DOT_GROW = { type: 'spring', duration: 0.36, bounce: 0.3 };
const DOT_FOLD = { duration: 0.36, ease: [0.33, 1, 0.68, 1] };
const DOT_STAGGER = 0.08;
// The row's geometry: a dot is 6px, the current screen's bar 22px, 6px apart.
const DOT = 6;
const BAR = 22;
const DOT_GAP = 6;

// The progress dots, keyed by place along the row: the dots ahead are all the
// same grey, so when a choice adds screens (the public profile's handle and
// page) the row simply gains dots at its end, each scaling up in its own place
// after the one before it; when it loses them they scale away, the last first.
// Given `dots.max`, the row is laid out at the width of its longest version and
// starts from the left of it, so dots coming and going leave the rest in place
// (at the cost of sitting a few pixels left of centre while it is shorter).
// Refused motion just redraws.
function ProgressDots({ dots, still }) {
  // The count before the last change: where the new dots start counting from.
  const [counts, setCounts] = useState({ now: dots.count, before: dots.count });
  if (counts.now !== dots.count) setCounts({ now: dots.count, before: counts.now });
  const { before } = counts;
  // One bar and the rest dots, a gap after each but the last.
  const span = (count) => (count - 1) * (DOT + DOT_GAP) + BAR;
  return (
    <ol
      className={`gw-dots${dots.max ? ' gw-dots--fixed' : ''}`}
      aria-label={dots.ariaLabel}
      style={dots.max ? { width: span(dots.max) } : undefined}
    >
      <AnimatePresence initial={false} custom={before}>
        {Array.from({ length: dots.count }, (_, index) => (
          <motion.li
            key={index}
            className={`gw-dot${index === dots.index ? ' is-active' : ''}${index < dots.index ? ' is-done' : ''}`}
            aria-current={index === dots.index ? 'step' : undefined}
            variants={{
              born: { opacity: 0, scale: 0 },
              shown: {
                opacity: 1,
                scale: 1,
                width: index === dots.index ? BAR : DOT,
                transition: still
                  ? { duration: 0 }
                  : { default: { ...DOT_GROW, delay: Math.max(0, index - before) * DOT_STAGGER }, width: DOT_FOLD },
              },
              // `custom` is the count before the change, so the last dot goes first.
              folded: (previousCount) => ({
                opacity: 0,
                scale: 0,
                transition: still ? { duration: 0 } : { ...DOT_FOLD, delay: Math.max(0, previousCount - 1 - index) * DOT_STAGGER },
              }),
            }}
            initial="born"
            animate="shown"
            exit="folded"
          >
            <span className="gw-dot-label">{dots.label(index + 1, dots.count)}</span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

// How many of an area's topics show before "Show more": two rows of the
// three-column grid. An area with only a couple past that shows them all —
// a button to reveal one or two cards costs more than the cards.
const SUBTOPICS_SHOWN = 6;
const SUBTOPICS_FOLD_MIN = SUBTOPICS_SHOWN + 3;

const SUBTOPICS_COPY = {
  topicsOf: area => `${area} topics`,
  showMore: n => `Show ${n} more`,
  showLess: 'Show less',
};

export function WelcomeShell({
  stepKey,
  direction,
  still,
  leaving,
  onLeaveComplete,
  className,
  stageClassName,
  dots,
  primary,
  back,
  skip,
  barAction,
  backdrop,
  landing = false,
  onStepShown,
  children,
}) {
  // The heading of a screen takes focus when the reader moves to it, so a
  // screen reader starts reading the new screen and a keyboard user starts
  // tabbing from its top. Not on the first paint: that is the page loading,
  // and the route announcer already speaks for it. The shell owns this rather
  // than each caller, because a new section mounting is exactly "the reader
  // moved"; comparing elements, not counting calls, keeps StrictMode's second
  // attach of the first section from counting as a move.
  const shownSection = useRef(null);
  const focusNewHeading = useCallback((section) => {
    if (!section) return;
    if (shownSection.current && shownSection.current !== section) {
      section.querySelector('.gw-title')?.focus({ preventScroll: true });
    }
    shownSection.current = section;
  }, []);

  // The key of the screen that will be shown, read when the exit completes.
  // AnimatePresence can call back with the handler from an earlier render: two
  // quick presses (back, back) changed the step again mid-exit, and a caller
  // closing over its own `step` was told the screen in between, so the landing
  // came up wearing the footer and Sign in of the screen after it.
  const latestStepKey = useRef(stepKey);
  useLayoutEffect(() => { latestStepKey.current = stepKey; }, [stepKey]);

  // Variants with `custom`, so the screen that is leaving reads the direction
  // of the move that is happening now — a prop captured when it last rendered
  // would send it out the way the PREVIOUS move went.
  const stepVariants = still
    ? {
      enter: { opacity: 1 },
      center: { opacity: 1 },
      exit: { opacity: 0, transition: { duration: 0 } },
    }
    : {
      enter: (dir) => ({ opacity: 0, x: dir * 28 }),
      center: { opacity: 1, x: 0, transition: { duration: 0.34, ease: [0.33, 1, 0.68, 1] } },
      exit: (dir) => ({ opacity: 0, x: dir * -28, transition: { duration: 0.18, ease: [0.32, 0, 0.67, 0] } }),
    };

  return (
    <motion.main
      className={`gw${className ? ` ${className}` : ''}`}
      animate={leaving && !still ? { opacity: 0, y: -16 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.32, 0, 0.67, 0] }}
      onAnimationComplete={() => {
        if (leaving && !still) onLeaveComplete?.();
      }}
    >
      {backdrop}
      <header className="gw-bar">
        <div className="gw-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
        <div className="gw-bar-actions">
          {/* Halftone on the landing only (design.md): elsewhere the bar stays quiet. */}
          <ThemeToggle className={`gw-bar-button${landing ? ' btn-halftone' : ''}`} />
          {barAction}
        </div>
      </header>

      <div className={`gw-stage${stageClassName ? ` ${stageClassName}` : ''}`}>
        {/* No `initial={false}` here: AnimatePresence hands it down to every
            motion component inside, and the illustrations would mount already
            finished. */}
        <AnimatePresence mode="wait" custom={direction} onExitComplete={() => onStepShown?.(latestStepKey.current)}>
          <motion.section
            key={stepKey}
            ref={focusNewHeading}
            className={`gw-step gw-step--${stepKey}`}
            custom={direction}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {children}
          </motion.section>
        </AnimatePresence>
      </div>

      <footer className="gw-foot">
        {/* The dots on every screen, the areas' too: a running count of what
            is picked used to sit here, and each tile already says whether it
            is on (`aria-pressed`), to the eye and to a screen reader. */}
        <ProgressDots dots={dots} still={still} />

        {/* The way forward and the two quiet ways round it, in one row: back
            where there is somewhere to go back to, the skip wherever the
            caller offers one. Bare icons, named for assistive tech and in a
            tooltip; each keeps its slot when absent, so the button never
            moves between screens. */}
        <div className="gw-actions">
          <span className="gw-action-slot">
            {back && (
              <Button
                variant="ghost"
                size="icon"
                className="gw-icon-action"
                onClick={back.onClick}
                aria-label={back.label}
                title={back.label}
              >
                <ArrowLeft size={20} aria-hidden="true" />
              </Button>
            )}
          </span>

          {/* `busy` keeps the button focusable: a disabled control drops the
              focus it holds, and the saving state is exactly when focus is on it. */}
          <Button
            variant="engraved"
            size="lg"
            type={primary.form ? 'submit' : 'button'}
            form={primary.form}
            onClick={primary.form ? undefined : primary.onClick}
            disabled={primary.disabled}
            aria-disabled={primary.busy || undefined}
            className="gw-primary"
          >
            {primary.label}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>

          <span className="gw-action-slot">
            {skip && (
              <Button
                variant="ghost"
                size="icon"
                className="gw-icon-action"
                onClick={skip.onClick}
                aria-label={skip.label}
                title={skip.label}
              >
                <SkipForward size={20} aria-hidden="true" />
              </Button>
            )}
          </span>
        </div>
      </footer>
    </motion.main>
  );
}

// A screen's kicker, heading and optional lede. Every screen draws its h1
// through this, so none ships without the heading the shell focuses.
export function WelcomeCopy({ kicker, title, lede }) {
  return (
    <div className="gw-copy">
      {kicker && <p className="gw-kicker">{kicker}</p>}
      <h1 className="gw-title" tabIndex={-1}>{title}</h1>
      {lede && <p className="gw-lede">{lede}</p>}
    </div>
  );
}

// The areas of the taxonomy as a grid of cards. `selected` is a Set of area
// keys; `onToggle(key)` flips one; `label` names the group.
export function AreaPicker({ selected, onToggle, label }) {
  return (
    <div className="gw-areas" role="group" aria-label={label}>
      {AREA_ENTRIES.map(([key, area], index) => (
        // The shared Toggle: a native button carrying
        // `aria-pressed` and `data-pressed`, which the CSS reads.
        <Toggle
          key={key}
          variant="outline"
          className="gw-area"
          pressed={selected.has(key)}
          onPressedChange={() => onToggle(key)}
          style={{ '--area-accent': area.gradient, '--i': index }}
        >
          <span className="gw-area-icon" aria-hidden="true">
            <area.icon size={20} weight={selected.has(key) ? 'fill' : 'regular'} />
          </span>
          <span className="gw-area-name">{area.label}</span>
          <span className="gw-area-box" aria-hidden="true">
            <Check size={11} weight="bold" />
          </span>
        </Toggle>
      ))}
    </div>
  );
}

// The areas' specific topics: the taxonomy's subcategories — the same ids a
// member's preferences hold and the feed plan routes by — drawn as the same
// cards as the areas, one group per area in `selectedAreas`, in its colour and
// with its glyph. `selectedTopics` is a Set of subcategory ids and
// `onToggleTopic(id)` flips one; `expandedAreas` is a Set of area keys whose
// fold is open and `onToggleExpanded(key)` opens or closes one.
export function SubtopicsPicker({ selectedAreas, selectedTopics, onToggleTopic, expandedAreas, onToggleExpanded }) {
  // Each group arrives whole, heading and cards together, one after the other
  // down the screen; `--i` is the group's place (GuestWelcome.css .gw-subtopics).
  return AREA_ENTRIES.filter(([key]) => selectedAreas.has(key)).map(([key, area], groupIndex) => {
    const areaLabel = area.label;
    const entries = Object.entries(area.subcategories);
    const folds = entries.length >= SUBTOPICS_FOLD_MIN;
    const expanded = !folds || expandedAreas.has(key);
    // Folded, the first few show — plus anything already picked
    // further down, so a choice never hides behind the fold.
    const shown = expanded
      ? entries
      : entries.filter(([id], index) => index < SUBTOPICS_SHOWN || selectedTopics.has(id));
    const hidden = entries.length - shown.length;
    const gridId = `gw-subtopics-${key}`;
    return (
      <section key={key} className="gw-subtopics" aria-label={SUBTOPICS_COPY.topicsOf(areaLabel)} style={{ '--i': groupIndex }}>
        <h2 className="gw-subtopics-title" style={{ '--area-accent': area.gradient }}>
          <area.icon size={18} weight="fill" aria-hidden="true" />
          {areaLabel}
        </h2>
        <div id={gridId} className="gw-areas" role="group" aria-label={SUBTOPICS_COPY.topicsOf(areaLabel)}>
          {shown.map(([id, sub]) => {
            const pressed = selectedTopics.has(id);
            return (
              <Toggle
                key={id}
                variant="outline"
                className="gw-area"
                pressed={pressed}
                onPressedChange={() => onToggleTopic(id)}
                style={{ '--area-accent': area.gradient }}
              >
                <span className="gw-area-icon" aria-hidden="true">
                  <area.icon size={20} weight={pressed ? 'fill' : 'regular'} />
                </span>
                <span className="gw-area-name">{sub.label}</span>
                <span className="gw-area-box" aria-hidden="true">
                  <Check size={11} weight="bold" />
                </span>
              </Toggle>
            );
          })}
        </div>
        {folds && (hidden > 0 || expanded) && (
          <button
            type="button"
            className="gw-more"
            aria-expanded={expanded}
            aria-controls={gridId}
            onClick={() => onToggleExpanded(key)}
          >
            {expanded ? SUBTOPICS_COPY.showLess : SUBTOPICS_COPY.showMore(hidden)}
            <CaretDown size={14} weight="bold" aria-hidden="true" className={expanded ? 'is-flipped' : undefined} />
          </button>
        )}
      </section>
    );
  });
}
