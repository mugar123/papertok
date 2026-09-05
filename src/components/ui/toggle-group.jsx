import { useContext } from 'react';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cn } from '../../lib/utils.js';
import { ToggleGroupContext } from './toggle-group-context.js';
import { toggleVariants } from './toggle-variants.js';

/**
 * Segmented choices: the selected item is a raised white chip on a sunken
 * track. Base UI's group is single-select unless `multiple`; `value` is
 * always an array and `onValueChange` receives the whole array:
 *
 *   <ToggleGroup value={[level]} onValueChange={([next]) => next && setLevel(next)}>
 *
 * (A single-select group reports `[]` when the pressed item is pressed
 * again; the caller decides whether "none" is allowed.)
 */
function ToggleGroup({ className, size = 'default', variant = 'default', children, ...props }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-size={size}
      data-variant={variant}
      className={cn(
        'flex w-fit items-center gap-1 rounded-md',
        variant === 'default' && 'border border-border bg-secondary p-1',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ size, variant }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({ className, children, variant, size, ...props }) {
  const context = useContext(ToggleGroupContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        'shrink-0 focus-visible:z-10',
        toggleVariants({ variant: variant ?? context.variant, size: size ?? context.size }),
        (variant ?? context.variant) === 'default' && 'rounded-sm',
        className,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem };
