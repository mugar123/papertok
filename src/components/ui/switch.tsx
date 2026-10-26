import type { StyledProps } from './props.ts';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '../../lib/utils.ts';
import { switchThumb, switchTrack } from './switch-variants.ts';

/**
 * An on/off setting (`role="switch"`). A sunken track with a hairline; on,
 * the track fills with ink and the thumb crosses. Pair it with a `<Label>`
 * (`htmlFor` to the switch's `id`) or wrap both in one.
 *
 * Track, thumb and travel are rem, so the switch grows with the browser's
 * text size as one piece (see switch-variants.ts).
 */
function Switch({ className, size = 'default', ...props }: StyledProps<typeof SwitchPrimitive.Root> & { size?: 'default' | 'sm' }) {
  return (
    <SwitchPrimitive.Root data-slot="switch" data-size={size} className={cn(switchTrack({ size }), className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={switchThumb({ size })} />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
