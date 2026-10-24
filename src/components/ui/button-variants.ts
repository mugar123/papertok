import { cva } from 'class-variance-authority';

/** Lives apart from button.jsx so that file exports only a component. */
// The press is a squeeze on the native `scale` property (Tailwind v4's
// `scale-*`), not a `transform`: callers animate buttons with framer, which
// writes `transform`, and the two compose instead of one replacing the other.
// Refused motion keeps the colour change and drops the squeeze.
// A button disabled with `focusableWhenDisabled` keeps focus and never gets
// the native attribute, so `:disabled` misses it; Base UI marks every
// disabled button `data-disabled`, and that takes the same look.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap no-underline rounded-md text-sm font-semibold transition-[color,background-color,border-color,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
  {
    variants: {
      variant: {
        // The quiet pair every screen uses: solid ink, and paper in an ink frame.
        default: 'bg-primary text-primary-foreground border border-foreground hover:bg-[var(--accent-primary-hover)]',
        outline: 'border border-[var(--border-ink)] bg-card text-foreground hover:bg-secondary',
        // The two patterned buttons (button.css). They draw the eye, so they are
        // asked for by name and only where design.md allows them — the landing
        // and the onboarding — which the papertok/patterned-buttons lint rule holds to a list.
        // Engraved: a hatched ink frame around a spot-yellow plate; hover and press fill the hatch.
        engraved: 'btn-engraved [transition:--hatch_90ms_steps(3,end),scale_120ms_var(--ease-out-expo)]',
        // Halftone: a paper plate over a 1-bit checker shadow offset 4px down-right.
        halftone: 'btn-halftone',
        ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        // The brand yellow is a highlighter, so it marks the AI reading action.
        // The soft wash flips with the theme and the full yellow does not, so
        // each surface takes its own ink: on hover it is ink on both sides.
        //
        // On hover the wash becomes the full spot plate in an ink frame, the
        // engraved button's look, and only the sparkles move: they turn and
        // grow a touch (220ms). The button itself stays on the page — it
        // lifted 2px with a shadow until 2026-10-15, and the page does
        // not float (design.md, The Print Does Not Float Rule). The press is
        // the base's 0.97 squeeze. Reduced motion keeps the colours and drops
        // the sparkles' turn.
        brand: 'bg-brand-soft text-[var(--text-on-brand-soft)] border border-[var(--brand-yellow)] hover:bg-brand hover:text-[var(--text-on-brand)] hover:border-[var(--border-ink)] [transition:color_160ms_linear,background-color_160ms_linear,border-color_160ms_linear,scale_120ms_var(--ease-out-expo)] [&_svg]:[transition:scale_220ms_var(--ease-out-quad),rotate_220ms_var(--ease-out-quad)] [&:hover_svg]:scale-110 [&:hover_svg]:rotate-[8deg] motion-reduce:[&:hover_svg]:scale-100 motion-reduce:[&:hover_svg]:rotate-0',
        // Tinted variants: a coloured surface that still reads as a control,
        // for actions that carry a meaning of their own rather than rank.
        violet: 'bg-[var(--accent-violet-soft)] text-[var(--accent-violet)] border border-[var(--accent-violet-line)] hover:bg-[var(--accent-violet)] hover:text-white hover:border-[var(--accent-violet)]',
        teal: 'bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border border-[var(--accent-teal-line)] hover:bg-[var(--accent-teal)] hover:text-white hover:border-[var(--accent-teal)]',
        rose: 'bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border border-[var(--accent-rose-line)] hover:bg-[var(--accent-rose)] hover:text-white hover:border-[var(--accent-rose)]',
        sky: 'bg-[var(--accent-sky-soft)] text-[var(--accent-sky)] border border-[var(--accent-sky-line)] hover:bg-[var(--accent-sky)] hover:text-white hover:border-[var(--accent-sky)]',
        success: 'bg-[var(--tint-green-bg)] text-[var(--tint-green-fg)] border border-[var(--tint-green-line)] hover:bg-[var(--accent-success)] hover:text-white hover:border-[var(--accent-success)]',
        // Takes its colour from --accent on the element, so a control can adopt
        // the research field of whatever it belongs to.
        field: 'bg-[color-mix(in_srgb,var(--accent,var(--accent-primary))_9%,var(--bg-card))] text-[var(--accent,var(--accent-primary))] border border-[color-mix(in_srgb,var(--accent,var(--accent-primary))_26%,var(--bg-card))] hover:bg-[var(--accent,var(--accent-primary))] hover:text-[var(--text-inverse)]',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
      },
      size: {
        default: 'h-10 px-4',
        sm: 'h-8 px-3 text-[0.8125rem]',
        lg: 'h-11 px-6',
        icon: 'h-10 w-10 p-0',
        'icon-sm': 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
