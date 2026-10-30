import type { StyledProps } from './props.ts';
import type { VariantProps } from 'class-variance-authority';

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cn } from '../../lib/utils.ts';
import { pendingToggleProps } from './toggle-press.ts';
import { toggleVariants } from './toggle-variants.ts';

type ToggleProps = StyledProps<typeof TogglePrimitive> & VariantProps<typeof toggleVariants> & {
  /**
   * The press is being saved. The toggle ignores presses, does not activate
   * the row around it, and stays focusable:
   * a native `disabled` would blur it, dropping a keyboard reader's focus to
   * the page, and Base UI's Toggle cannot be disabled and focusable at once.
   */
  pending?: boolean;
};

/**
 * A button with an on/off state (`aria-pressed`): a filter chip, a like, a
 * "show map" switch. Base UI sets `data-pressed`, which is what the
 * variants style. Inside a ToggleGroup use ToggleGroupItem instead.
 */
export function Toggle({ className, variant, size, pending = false, onClick, ...props }: ToggleProps) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...pendingToggleProps(pending, onClick)}
      {...props}
    />
  );
}
