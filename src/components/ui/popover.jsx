import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '../../lib/utils.js';

/**
 * A non-modal panel anchored to its trigger: a preferences tray, a date
 * picker, an export card. Base UI positions it (`--transform-origin` is
 * where it grows from), closes it on outside press and Escape, and keeps
 * focus sane. Transitions, not animations, because a popover the user
 * closes mid-arrival should turn back smoothly.
 */
function Popover(props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverClose(props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 6,
  positionerClassName,
  ...props
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className={cn('isolate z-[12055]', positionerClassName)}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'w-72 origin-(--transform-origin) rounded-lg border border-border bg-card p-3 text-[0.8125rem] text-foreground shadow-[var(--shadow-lg)] outline-none',
            'motion-safe:transition-[opacity,scale] motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]',
            'data-starting-style:opacity-0 data-starting-style:scale-[0.97] data-ending-style:opacity-0 data-ending-style:scale-[0.98]',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }) {
  return <div data-slot="popover-header" className={cn('flex flex-col gap-0.5', className)} {...props} />;
}

/* A popover's title is a section label: mono, tracked, uppercase. */
function PopoverTitle({ className, ...props }) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn('font-mono text-[0.6875rem] font-semibold uppercase tracking-[var(--mono-track)] text-[var(--text-tertiary)]', className)}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
