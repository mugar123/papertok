import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '../../lib/utils.js';

/**
 * A label on hover and focus, in mono like every other piece of machine
 * data. The provider is optional: wrap a cluster of icon buttons in one so
 * moving between them does not re-wait the delay.
 */
function TooltipProvider({ delay = 300, ...props }) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip(props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/* `anchor` reaches the positioner: an element, a ref or a virtual element
   with `getBoundingClientRect`, for a tooltip that follows something other
   than its trigger (a pointer over a map). */
function TooltipContent({ className, side = 'top', sideOffset = 6, align = 'center', alignOffset = 0, anchor, children, ...props }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        anchor={anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-[12060]"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'w-fit max-w-xs origin-(--transform-origin) rounded-md bg-foreground px-2 py-1',
            'font-mono text-[0.6875rem] font-medium text-[var(--text-inverse)]',
            'motion-safe:transition-[opacity,scale] motion-safe:duration-100',
            'data-starting-style:opacity-0 data-starting-style:scale-[0.97] data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
