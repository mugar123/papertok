import type { ComponentProps } from 'react';
import type { StyledProps } from './props.ts';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '../../lib/utils.ts';

/**
 * One for the whole app (App.jsx). A tooltip appears after the pointer has
 * rested on its trigger for 600ms, never on a quick pass; once one is showing,
 * its neighbours open at once, which only works when they share this group.
 */
function TooltipProvider(props: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delay={600} {...props} />;
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/** Same frame as the popover (ui/popover.jsx), a size down, growing from the trigger. */
function TooltipContent({ className, align = 'center', ...props }: StyledProps<typeof TooltipPrimitive.Popup> & { align?: 'start' | 'center' | 'end' }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side="top" align={align} sideOffset={6} className="isolate z-[12060]">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'max-w-64 origin-(--transform-origin) rounded-md border border-border bg-card px-2 py-1 text-[0.75rem] text-foreground shadow-[var(--shadow-md)]',
            'motion-safe:[transition:opacity_120ms_ease-out,scale_120ms_var(--ease-out-cubic)]',
            'motion-safe:data-instant:[transition:none]',
            'data-starting-style:opacity-0 data-starting-style:scale-[0.96] data-ending-style:opacity-0',
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
