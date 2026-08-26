import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Dialog, DialogContent, DialogTitle } from './dialog.jsx';

function Command({ className, ...props }) {
  return (
    <CommandPrimitive
      className={cn('flex h-full w-full flex-col overflow-hidden bg-card text-foreground', className)}
      {...props}
    />
  );
}

/**
 * The palette itself: anchored near the top rather than centred, so results
 * grow downwards from the field the way a search dropdown does.
 *
 * `className` reaches the sheet so a caller can give it its own enter/exit
 * motion. It is passed in rather than written here because the shorthand for
 * that motion belongs in a stylesheet — a Tailwind arbitrary value carrying a
 * `cubic-bezier(...)` is a lot of escaping for something a `.css` file says
 * plainly — and this module has no stylesheet of its own to put it in.
 */
function CommandDialog({ children, className, title = 'Search', ...props }) {
  return (
    <Dialog {...props}>
      <DialogContent
        showClose={false}
        className={cn('top-[8vh] max-w-2xl translate-y-0 overflow-hidden p-0', className)}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <Command shouldFilter={false} loop>
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The field is a line inside the sheet, not a box on top of one.
 *
 * `border-0 shadow-none` are load-bearing. The element reset in `global.css`
 * gives every `input` a border and a radius, and `input:focus` an ink border
 * plus `--shadow-glow-primary` — so this field, which opens `autoFocus`ed,
 * painted a heavy black rectangle around itself the instant the palette
 * appeared, and read as "your text got selected". The sheet already has a
 * border and a rule under this row; a second box inside it is noise. `px-0`
 * likewise drops the reset's `--space-4` inset, so the placeholder sits next to
 * the magnifier rather than 24px away from it.
 *
 * Overriding it needs no `!important`: `global.css` declares
 * `@layer theme, base, components, utilities`, so any utility beats the base
 * reset whatever its specificity. `SearchPage.css` predates that and still
 * fights the same rule with `!important`.
 *
 * `py-2` on the row is the air around the field. It was `pt-2`, which pushed
 * the field down without giving it the matching room underneath, so it sat off
 * centre in its own band.
 */
function CommandInput({ className, ...props }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <Search size={16} className="shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          'flex h-12 w-full border-0 bg-transparent px-0 py-3 text-[0.9375rem] shadow-none outline-none',
          'placeholder:text-[var(--text-tertiary)]',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[60vh] overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  );
}

function CommandEmpty(props) {
  return <CommandPrimitive.Empty className="px-4 py-8 text-center text-sm text-muted-foreground" {...props} />;
}

function CommandGroup({ className, ...props }) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden p-1 text-foreground',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
        '[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[0.6875rem]',
        '[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase',
        '[&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none',
        'data-[selected=true]:bg-secondary data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }) {
  return <CommandPrimitive.Separator className={cn('-mx-1 h-px bg-border', className)} {...props} />;
}

function CommandLoading(props) {
  return <CommandPrimitive.Loading {...props} />;
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
  CommandSeparator,
};
