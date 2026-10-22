import type { StyledProps } from './props.ts';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '../../lib/utils.ts';

/**
 * An on/off setting (`role="switch"`). A sunken track with a hairline; on,
 * the track fills with ink and the thumb crosses. Pair it with a `<Label>`
 * (`htmlFor` to the switch's `id`) or wrap both in one.
 *
 * Track, thumb and travel are all rem, so the switch grows with the browser's
 * text size as one piece. The track is `box-content`: its 1px hairline sits
 * outside the rem box, and the thumb keeps the same inset on every side.
 */
function Switch({ className, size = 'default', ...props }: StyledProps<typeof SwitchPrimitive.Root> & { size?: 'default' | 'sm' }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer relative box-content inline-flex shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        'border-[var(--border-strong)] bg-[var(--bg-sunken)] data-checked:border-[var(--border-ink)] data-checked:bg-primary',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        'data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-card shadow-[var(--shadow-sm)]',
          'motion-safe:transition-transform motion-safe:duration-150',
          'in-data-[size=default]:size-4 in-data-[size=default]:translate-x-0.5 in-data-[size=default]:data-checked:translate-x-4.5',
          'in-data-[size=sm]:size-3 in-data-[size=sm]:translate-x-0.5 in-data-[size=sm]:data-checked:translate-x-3.5',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
