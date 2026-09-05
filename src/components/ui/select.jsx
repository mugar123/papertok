import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * A listbox behind a field-shaped trigger. Base UI keeps the native form
 * value (`name`), typeahead and keyboard selection; the popup opens aligned
 * on the chosen item like a native select unless `alignItemWithTrigger` is
 * off. Items are `role="option"`; the trigger is a real button.
 */
const Select = SelectPrimitive.Root;

function SelectGroup({ className, ...props }) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn('scroll-my-1 p-1', className)} {...props} />;
}

function SelectValue({ className, ...props }) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn('flex flex-1 truncate text-left', className)} {...props} />;
}

function SelectTrigger({ className, size = 'default', children, ...props }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        'flex w-fit min-w-0 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-border bg-card px-3 text-[0.8125rem] text-foreground transition-colors',
        'hover:border-[var(--border-strong)] data-popup-open:border-[var(--border-ink)]',
        'data-placeholder:text-[var(--text-tertiary)] disabled:cursor-not-allowed disabled:opacity-50',
        'data-[size=default]:h-9 data-[size=sm]:h-8',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon render={<ChevronDown size={15} className="text-muted-foreground" aria-hidden="true" />} />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-[12055]"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'relative max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto overflow-x-hidden',
            'rounded-md border border-border bg-card text-[0.8125rem] text-foreground shadow-[var(--shadow-lg)] outline-none',
            'motion-safe:transition-[opacity,scale] motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]',
            'data-starting-style:opacity-0 data-starting-style:scale-[0.98] data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className="top-0 z-10 flex w-full cursor-default items-center justify-center bg-card py-1">
            <ChevronUp size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className="bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-card py-1">
            <ChevronDown size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2 py-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-[var(--mono-track)] text-[var(--text-tertiary)]', className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 outline-none',
        'data-highlighted:bg-secondary data-highlighted:text-foreground data-selected:font-semibold',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex flex-1 gap-2 whitespace-nowrap">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator render={<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />}>
        <Check size={14} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
