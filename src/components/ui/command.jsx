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
 *
 * `wrapperClassName` / `wrapperStyle` reach the row rather than the field, for
 * the same reason `CommandDialog` takes a `className` for the sheet: the row is
 * what a caller has to be able to move if the field is to take part in the
 * palette's entrance. Styling `className` instead would animate the `input`
 * inside a row that stayed put, which is the opposite of the point.
 */
function CommandInput({ className, wrapperClassName, wrapperStyle, ...props }) {
  return (
    <div
      className={cn('flex items-center gap-2 border-b border-border px-4 py-2', wrapperClassName)}
      style={wrapperStyle}
    >
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

/**
 * A result row, and the ring that says the arrow keys are on it.
 *
 * `data-[selected=true]:bg-secondary` used to be the whole indicator, and it is
 * not one: measured in the browser with the palette open, the tint computes
 * `rgb(26, 29, 36)` over the sheet's `rgb(22, 25, 31)` — 1.04:1 on ink, 1.07:1
 * on paper, against the 3:1 WCAG 1.4.11 asks of the visual information that
 * identifies a component's state. The tint stays because it makes the row read
 * as one object, but the thing you actually see is the ring.
 *
 * It is drawn in `var(--focus-ring)` rather than in a colour of its own: this
 * is the same "you are here" the rest of the app draws with `:focus-visible`
 * (`styles/global.css`, `components/ui/button-variants.js`), and it is the one
 * token that flips per theme (#b45309 on paper, #ff9d00 on ink) so that it
 * clears 3:1 on both without depending on what is behind it. The offset is
 * negative because the rows sit flush against each other inside `CommandList`'s
 * 1px of padding, where an outset ring overlaps its neighbours and is clipped
 * by the list's own overflow at the top and bottom of the scroll.
 *
 * There is no `outline-none` here any more. It was harmless while nothing drew
 * an outline — cmdk keeps DOM focus on the field and moves the rows through
 * `aria-activedescendant`, so no row was ever hiding a ring — but Tailwind v4
 * writes it as `--tw-outline-style: none`, and `outline-2` paints
 * `outline-style: var(--tw-outline-style)`. Together on this element they
 * resolve to `outline-style: none` and the row silently falls back to the
 * 1.04:1 tint, with every class below still present and still reading right.
 */
function CommandItem({ className, ...props }) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm',
        'data-[selected=true]:bg-secondary data-[selected=true]:outline-2',
        'data-[selected=true]:-outline-offset-2 data-[selected=true]:outline-[var(--focus-ring)]',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
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
