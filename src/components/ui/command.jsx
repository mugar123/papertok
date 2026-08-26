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
 */
function CommandDialog({ children, title = 'Search', ...props }) {
  return (
    <Dialog {...props}>
      <DialogContent
        showClose={false}
        className="top-[8vh] max-w-2xl translate-y-0 overflow-hidden p-0"
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
 * The field sat flush against the top edge of the sheet — `h-12` and nothing
 * above it — so the palette opened with its one control jammed into the corner.
 * The extra top padding is the only air the search bar gets, since the sheet
 * has no chrome of its own above it.
 */
function CommandInput({ className, ...props }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 pt-2">
      <Search size={16} className="shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          'flex h-12 w-full bg-transparent py-3 text-[0.9375rem] outline-none placeholder:text-[var(--text-tertiary)]',
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
