import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from '../../lib/utils.js';

/**
 * One choice among a few (`role="radiogroup"`, arrow keys between items).
 * `RadioGroupItem` is the dot; for the app's card-shaped choices (an icon
 * picker, the visibility choice) render the card through `render` and let
 * the `data-checked` attribute style it — the group semantics still hold:
 *
 *   <RadioGroupItem value="public" render={<div className="choice-card" />}>…</RadioGroupItem>
 */
function RadioGroup({ className, ...props }) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn('grid gap-2', className)} {...props} />;
}

function RadioGroupItem({ className, children, render, ...props }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      render={render}
      className={cn(
        !render && [
          'peer relative flex aspect-square size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
          'border-[var(--border-strong)] bg-card data-checked:border-[var(--border-ink)]',
          'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        ],
        className,
      )}
      {...props}
    >
      {render ? children : (
        <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="size-2 rounded-full bg-primary" />
      )}
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
