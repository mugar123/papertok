import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cn } from '../../lib/utils.js';

/**
 * A menu of actions: `role="menu"`, arrow keys, typeahead, submenus. The
 * Explorer's sort menu and anything else that lists commands. Not for a
 * tray of settings that are not commands — that is a Popover.
 */
function DropdownMenu(props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({ align = 'start', alignOffset = 0, side = 'bottom', sideOffset = 6, className, ...props }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-[12055] outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            'max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-y-auto overflow-x-hidden',
            'rounded-lg border border-border bg-card p-1 text-[0.8125rem] text-foreground shadow-[var(--shadow-lg)] outline-none',
            'motion-safe:transition-[opacity,scale] motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]',
            'data-starting-style:opacity-0 data-starting-style:scale-[0.97] data-ending-style:opacity-0 data-ending-style:scale-[0.98]',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
};
