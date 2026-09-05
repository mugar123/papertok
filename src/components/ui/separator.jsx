import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';
import { cn } from '../../lib/utils.js';

/** A hairline rule (rule 4: structure is rules, not shadows). */
function Separator({ className, orientation = 'horizontal', ...props }) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:h-full data-vertical:w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
