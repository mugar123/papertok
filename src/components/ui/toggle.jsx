import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cn } from '../../lib/utils.js';
import { toggleVariants } from './toggle-variants.js';

/**
 * A button with an on/off state (`aria-pressed`): a filter chip, a like, a
 * "show map" switch. Base UI sets `data-pressed`, which is what the
 * variants style. Inside a ToggleGroup use ToggleGroupItem instead.
 */
export function Toggle({ className, variant, size, ...props }) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
}
