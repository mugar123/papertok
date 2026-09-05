import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * A near-square box (rule 4) that fills with ink when checked. Base UI
 * renders a real button with `role="checkbox"` and a hidden input for
 * forms; `indeterminate` shows a dash instead of the tick.
 */
function Checkbox({ className, ...props }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
        'border-[var(--border-strong)] bg-card text-primary-foreground',
        'data-checked:border-[var(--border-ink)] data-checked:bg-primary data-indeterminate:border-[var(--border-ink)] data-indeterminate:bg-primary',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center text-current">
        <Check size={11} strokeWidth={3.5} aria-hidden="true" className="group-data-indeterminate/checkbox:hidden" />
        <Minus size={11} strokeWidth={3.5} aria-hidden="true" className="hidden group-data-indeterminate/checkbox:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
