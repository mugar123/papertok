import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '../../lib/utils.js';

/**
 * An on/off setting (`role="switch"`). A sunken track with a hairline; on,
 * the track fills with ink and the thumb crosses. Pair it with a `<Label>`
 * (`htmlFor` to the switch's `id`) or wrap both in one.
 */
function Switch({ className, size = 'default', ...props }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        'border-[var(--border-strong)] bg-[var(--bg-sunken)] data-checked:border-[var(--border-ink)] data-checked:bg-primary',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        'data-[size=default]:h-[22px] data-[size=default]:w-[38px] data-[size=sm]:h-[18px] data-[size=sm]:w-[30px]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-card shadow-[var(--shadow-sm)]',
          'motion-safe:transition-transform motion-safe:duration-150',
          'in-data-[size=default]:size-4 in-data-[size=default]:translate-x-[2px] in-data-[size=default]:data-checked:translate-x-[18px]',
          'in-data-[size=sm]:size-3 in-data-[size=sm]:translate-x-[2px] in-data-[size=sm]:data-checked:translate-x-[14px]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
