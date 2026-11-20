import type { StyledProps } from './props.ts';
import type { ComponentProps } from 'react';

import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import { cn } from '../../lib/utils.ts';

/**
 * The menu a right click opens on its trigger: the same `role="menu"`, arrow
 * keys and typeahead as DropdownMenu, the same frame and rows. The browser
 * also sends the right click's event for the keyboard's menu key and
 * Shift+F10 where the platform has them; a trigger that must open from the
 * keyboard everywhere controls `open` itself. A context menu is never the
 * only way to an action (design.md): the same commands live in a visible
 * control elsewhere.
 */
function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger(props: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

/**
 * Opens at the pointer unless given an `anchor`. It arrives on opacity alone:
 * a scale entrance would carry its row icons a pixel (design.md, Traps).
 */
function ContextMenuContent({ anchor, align = 'start', alignOffset, side, sideOffset, className, ...props }: StyledProps<typeof ContextMenuPrimitive.Popup> & Pick<ComponentProps<typeof ContextMenuPrimitive.Positioner>, 'anchor' | 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-[12055] outline-none"
        anchor={anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            'max-h-(--available-height) min-w-40 overflow-y-auto overflow-x-hidden',
            'rounded-lg border border-border bg-card p-1 text-[0.8125rem] text-foreground shadow-[var(--shadow-lg)] outline-none',
            'motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-[var(--ease-out-expo)]',
            'data-starting-style:opacity-0 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({ className, ...props }: StyledProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-[0.8125rem] font-medium text-foreground outline-none',
        'data-highlighted:bg-secondary [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        'data-disabled:cursor-default data-disabled:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
};
