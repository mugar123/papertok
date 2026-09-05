import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '../../lib/utils.js';

/**
 * A text field in the app's marking vocabulary: a hairline box, near-square,
 * and on focus the border turns to ink doubled by an inset hairline (that
 * rule lives in `styles/global.css`, keyed on `:focus-visible`, so it is
 * not repeated here). Base UI's Input registers with a surrounding Field
 * when there is one and otherwise is a plain `<input>`.
 *
 * `text-base` (16px) on purpose: iOS zooms into any field smaller than that.
 */
function Input({ className, type = 'text', ...props }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-md border border-border bg-card px-3 text-base text-foreground transition-colors',
        'placeholder:text-[var(--text-tertiary)] hover:border-[var(--border-strong)]',
        'file:mr-3 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-[0.8125rem] file:font-semibold file:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--tint-red-fg)]',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
