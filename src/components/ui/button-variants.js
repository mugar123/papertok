import { cva } from 'class-variance-authority';

/** Lives apart from button.jsx so that file exports only a component. */
// The press is a squeeze on the native `scale` property (Tailwind v4's
// `scale-*`), not a `transform`: callers animate buttons with framer, which
// writes `transform`, and the two compose instead of one replacing the other.
// Refused motion keeps the colour change and drops the squeeze.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-[color,background-color,border-color,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground border border-foreground hover:bg-[var(--accent-primary-hover)]',
        outline: 'border border-border bg-card text-foreground hover:bg-secondary hover:border-[var(--border-strong)]',
        ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        // The brand yellow is a highlighter, so it marks the AI reading action.
        // The soft wash flips with the theme and the full yellow does not, so
        // each surface takes its own ink: on hover it is ink on both sides.
        //
        // And it moves: the card's AI button lifted 2px under the pointer and
        // gave 4% under the finger (`.pc-ai-btn`, until e56a7ea moved it onto
        // this component with colours only, 2026-08-29), and the reader is
        // reported to have lost exactly that. `translate` and `scale` are the
        // individual properties in Tailwind 4, so the press does not undo the
        // lift by overwriting one `transform`; `active:translate-y-0` puts the
        // button back on the page while it is held, as the old rule did. 180ms
        // on the expo-out curve, the card's own arrival curve. Reduced motion
        // keeps the colours and gives up the movement (design.md, rule 7).
        //
        // Polished 2026-09-18: one clock for everything read as a snap, so
        // each property has its own. The colours cross on a straight line
        // (160ms: an expo on a colour is a flash); the lift arrives on the
        // expo curve (180ms, it lands where the eye is) and goes back on the
        // quad (220ms, it is seen settling); the press is the quickest thing
        // here (120ms) and flattens the shadow the lift raised; the sparkles
        // turn and grow a touch with the lift. Reduced motion keeps the
        // colours and gives up every movement.
        brand: 'bg-brand-soft text-[var(--text-on-brand-soft)] border border-[var(--tint-amber-line)] hover:bg-brand hover:text-[var(--text-on-brand)] hover:border-[var(--brand-orange)] [transition:color_160ms_linear,background-color_160ms_linear,border-color_160ms_linear,box-shadow_220ms_var(--ease-out-quad),translate_220ms_var(--ease-out-quad),scale_120ms_var(--ease-out-expo)] hover:[transition:color_160ms_linear,background-color_160ms_linear,border-color_160ms_linear,box-shadow_180ms_var(--ease-out-expo),translate_180ms_var(--ease-out-expo),scale_120ms_var(--ease-out-expo)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] active:translate-y-0 active:scale-[0.96] active:shadow-none [&_svg]:[transition:scale_220ms_var(--ease-out-quad),rotate_220ms_var(--ease-out-quad)] [&:hover_svg]:scale-110 [&:hover_svg]:rotate-[8deg] motion-reduce:hover:translate-y-0 motion-reduce:hover:shadow-none motion-reduce:active:scale-100 motion-reduce:[&:hover_svg]:scale-100 motion-reduce:[&:hover_svg]:rotate-0',
        // Tinted variants: a coloured surface that still reads as a control,
        // for actions that carry a meaning of their own rather than rank.
        violet: 'bg-[var(--accent-violet-soft)] text-[var(--accent-violet)] border border-[var(--accent-violet-line)] hover:bg-[var(--accent-violet)] hover:text-white hover:border-[var(--accent-violet)]',
        teal: 'bg-[var(--accent-teal-soft)] text-[var(--accent-teal)] border border-[var(--accent-teal-line)] hover:bg-[var(--accent-teal)] hover:text-white hover:border-[var(--accent-teal)]',
        rose: 'bg-[var(--accent-rose-soft)] text-[var(--accent-rose)] border border-[var(--accent-rose-line)] hover:bg-[var(--accent-rose)] hover:text-white hover:border-[var(--accent-rose)]',
        sky: 'bg-[var(--accent-sky-soft)] text-[var(--accent-sky)] border border-[var(--accent-sky-line)] hover:bg-[var(--accent-sky)] hover:text-white hover:border-[var(--accent-sky)]',
        success: 'bg-[var(--tint-green-bg)] text-[var(--tint-green-fg)] border border-[var(--tint-green-line)] hover:bg-[var(--accent-success)] hover:text-white hover:border-[var(--accent-success)]',
        // Takes its colour from --accent on the element, so a control can adopt
        // the research field of whatever it belongs to.
        field: 'bg-[color-mix(in_srgb,var(--accent,#111318)_9%,white)] text-[var(--accent,#111318)] border border-[color-mix(in_srgb,var(--accent,#111318)_26%,white)] hover:bg-[var(--accent,#111318)] hover:text-white',
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
