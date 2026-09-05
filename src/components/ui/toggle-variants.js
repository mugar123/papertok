import { cva } from 'class-variance-authority';

/** Lives apart from toggle.jsx so that file exports only a component. */
export const toggleVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors',
    'text-muted-foreground hover:text-foreground',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        // A raised white chip on whatever track it sits in.
        default: 'bg-transparent data-pressed:bg-card data-pressed:text-foreground data-pressed:font-semibold data-pressed:shadow-[var(--shadow-sm)]',
        // A bordered chip that fills with ink when on — the onboarding's
        // category chips, the guest interests prompt.
        outline: 'border border-border bg-card hover:bg-secondary data-pressed:border-[var(--border-ink)] data-pressed:bg-primary data-pressed:text-primary-foreground',
        // The yellow thread: only for the AI reading action and highlights
        // (design.md, rule 3).
        brand: 'border border-border bg-card data-pressed:border-[var(--tint-amber-line)] data-pressed:bg-brand-soft data-pressed:text-[var(--text-on-brand-soft)]',
      },
      size: {
        default: 'h-8 px-3 text-[0.8125rem]',
        sm: 'h-7 px-2 text-[0.75rem]',
        lg: 'h-10 px-4 text-[0.875rem]',
        icon: 'h-8 w-8 p-0',
        'icon-sm': 'h-7 w-7 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
