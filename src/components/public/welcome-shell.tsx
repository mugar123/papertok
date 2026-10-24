import type { MouseEventHandler, PropsWithChildren, ReactNode } from 'react';
import type { Variants } from 'framer-motion';
import type { Progress } from './progress-dots.tsx';
interface WelcomeAction { label: string; onClick?: MouseEventHandler<HTMLButtonElement> }
interface WelcomeShellProps extends PropsWithChildren {
  stepKey: string; direction: number; still?: boolean | null;
  className?: string; stageClassName?: string;
  dots: Progress; primary: WelcomeAction & { form?: string; disabled?: boolean; busy?: boolean };
  back?: WelcomeAction | null; skip?: WelcomeAction | null;
  barAction?: ReactNode; backdrop?: ReactNode; landing?: boolean;
  onStepShown?: (key: string) => void;
}
import { useCallback, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, CaretDown, Check, SkipForward } from '@phosphor-icons/react';
import { INTEREST_AREAS } from '../../data/categories.ts';
import ThemeToggle from '../layout/theme-toggle.tsx';
import ProgressDots from './progress-dots.tsx';
import { Button } from '../ui/button.tsx';
import { Toggle } from '../ui/toggle.tsx';
import './guest-welcome.css';

// The welcome's page and its two pickers, shared by every flow drawn in the
// welcome's layout. The styles stay in guest-welcome.css under `gw-*`.
//
// <WelcomeShell> draws, in order:
// - `<main className="gw …">`.
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

const AREA_ENTRIES = Object.entries(INTEREST_AREAS);

// How many of an area's topics show before "Show more": two rows of the
// three-column grid. An area with only a couple past that shows them all —
// a button to reveal one or two cards costs more than the cards.
const SUBTOPICS_SHOWN = 6;
const SUBTOPICS_FOLD_MIN = SUBTOPICS_SHOWN + 3;

const SUBTOPICS_COPY = {
  topicsOf: (area: string) => `${area} topics`,
  showMore: (n: number) => `Show ${n} more`,
  showLess: 'Show less',
};

export function WelcomeShell({
  stepKey,
  direction,
  still,
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
}: WelcomeShellProps) {
  // The heading of a screen takes focus when the reader moves to it, so a
  // screen reader starts reading the new screen and a keyboard user starts
  // tabbing from its top. Not on the first paint: that is the page loading,
  // and the route announcer already speaks for it. The shell owns this rather
  // than each caller, because a new section mounting is exactly "the reader
  // moved"; comparing elements, not counting calls, keeps StrictMode's second
  // attach of the first section from counting as a move.
  const shownSection = useRef<HTMLElement | null>(null);
  const focusNewHeading = useCallback((section: HTMLElement | null) => {
    if (!section) return;
    if (shownSection.current && shownSection.current !== section) {
      section.querySelector<HTMLElement>('.gw-title')?.focus({ preventScroll: true });
    }
    shownSection.current = section;
  }, []);


  const latestStepKey = useRef(stepKey);
  useLayoutEffect(() => { latestStepKey.current = stepKey; }, [stepKey]);

  // Variants with `custom`, so the screen that is leaving reads the direction
  // of the move that is happening now — a prop captured when it last rendered
  // would send it out the way the PREVIOUS move went.
  const stepVariants: Variants = still
    ? {
      enter: { opacity: 1 },
      center: { opacity: 1 },
      exit: { opacity: 0, transition: { duration: 0 } },
    }
    : {
      enter: (dir: number) => ({ opacity: 0, x: dir * 28 }),
      center: { opacity: 1, x: 0, transition: { duration: 0.34, ease: [0.33, 1, 0.68, 1] } },
      exit: (dir: number) => ({ opacity: 0, x: dir * -28, transition: { duration: 0.18, ease: [0.32, 0, 0.67, 0] } }),
    };

  return (
    <main className={`gw${className ? ` ${className}` : ''}`}>
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
    </main>
  );
}

// A screen's kicker, heading and optional lede. Every screen draws its h1
// through this, so none ships without the heading the shell focuses.
export function WelcomeCopy({ kicker, title, lede }: { kicker?: ReactNode; title: ReactNode; lede?: ReactNode }) {
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
export function AreaPicker({ selected, onToggle, label }: { selected: Set<string>; onToggle: (key: string) => void; label: string }) {
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
export function SubtopicsPicker({ selectedAreas, selectedTopics, onToggleTopic, expandedAreas, onToggleExpanded }: { selectedAreas: Set<string>; selectedTopics: Set<string>; onToggleTopic: (id: string) => void; expandedAreas: Set<string>; onToggleExpanded: (key: string) => void }) {
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
