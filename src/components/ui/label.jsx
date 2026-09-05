import { cn } from '../../lib/utils.js';

/**
 * A field's name. Every field has one (WCAG 3.3.2): `htmlFor` to the
 * control's `id`, or wrap the control. Small, semibold Inter — a label is a
 * control's caption, not machine data, so it is not set in mono.
 */
function Label({ className, ...props }) {
  return (
    <label
      data-slot="label"
      className={cn(
        'inline-flex items-center gap-2 text-[0.8125rem] font-semibold leading-none text-foreground select-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
