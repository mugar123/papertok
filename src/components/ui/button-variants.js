import { cva } from 'class-variance-authority';

/** Lives apart from button.jsx so that file exports only a component. */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground border border-foreground hover:bg-[var(--accent-primary-hover)]',
        outline: 'border border-border bg-card text-foreground hover:bg-secondary hover:border-[var(--border-strong)]',
        ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        // The brand yellow is a highlighter, so it marks the AI reading action.
        // The soft wash flips with the theme and the full yellow does not, so
        // each surface takes its own ink: on hover it is ink on both sides.
        brand: 'bg-brand-soft text-[var(--text-on-brand-soft)] border border-[var(--tint-amber-line)] hover:bg-brand hover:text-[var(--text-on-brand)] hover:border-[var(--brand-orange)]',
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
