import { Command as CommandPrimitive } from 'cmdk';
import { MagnifyingGlass } from '@phosphor-icons/react';
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
 *
 * `finalFocus` reaches the popup: a palette opened by a button that is not a
 * Base UI Trigger has to be told where focus goes back to when it closes.
 *
 * The top offset is set in `dvh`, not the large-viewport `vh`: this is a
 * `position: fixed` sheet, so its offset should track the visible viewport as
 * the URL bar hides and reveals, the same as every other fixed sheet in this
 * repo. Unlike a `.css` file, a Tailwind arbitrary value cannot carry a
 * large-viewport fallback the way `FeedContainer.css:15-16` does —
 * `tailwind-merge` (via `cn`) drops conflicting utilities for the same
 * property down to the last one, so a second bracket value in the old unit
 * here would just be dead code, not a fallback. `dvh` already ships bare
 * elsewhere in this codebase (the sheet's `max-height` in `drawer.css`) and
 * has near-universal support, so going bare here matches that precedent.
 */
function CommandDialog({ children, className, overlayClassName, finalFocus, title = 'Search', ...props }) {
  return (
    <Dialog {...props}>
      <DialogContent
        showClose={false}
        overlayClassName={overlayClassName}
        finalFocus={finalFocus}
        className={cn('top-[8dvh] max-w-2xl translate-y-0 overflow-hidden p-0', className)}
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
 * border and a rule under this row; a second box inside it is noise. `px-2`
 * likewise drops the reset's `--space-4` inset, so the placeholder sits near
 * the magnifier rather than 24px away from it — but not `px-0`: the focus
 * indicator `global.css` gives every text field is a hairline `inset 0 0 0
 * 1px`, drawn just inside the box, and with no horizontal padding the box's
 * edge IS the first glyph's edge. The hairline read as overlapping the "S" of
 * the placeholder (user, 2026-09-03). 8px is what puts air between the two;
 * the row's `gap-1.5` gives back part of the shift so the text still starts
 * close to the magnifier.
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
 *
 * `children` land after the field, in the same row: the one place a control
 * that belongs to the field — the palette's Cancel on a phone, where there is
 * no Escape key and the full-screen sheet leaves no scrim to tap — can sit
 * without becoming a second row.
 */
function CommandInput({ className, wrapperClassName, wrapperStyle, children, ...props }) {
  return (
    <div
      className={cn('flex items-center gap-1.5 border-b border-border px-4 pt-3 pb-1.5', wrapperClassName)}
      style={wrapperStyle}
    >
      <MagnifyingGlass size={16} className="shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          // 16px, not 15: iOS Safari auto-zooms the page when a focused
          // field's font is under 16px, and this field opens autoFocused —
          // the palette zoomed the whole app on every open (a real iPhone,
          // 2026-08-29). Same rule as the reader's note textarea.
          'flex h-9 w-full border-0 bg-transparent px-2 py-1.5 text-[1rem] shadow-none outline-none',
          'placeholder:text-[var(--text-tertiary)]',
          className,
        )}
        {...props}
      />
      {children}
    </div>
  );
}

/**
 * `svh`, not `dvh`: this is the scrolled results list itself
 * (`overflow-y-auto`), and nothing here transitions its `max-height` the way
 * `.related-sheet` in `PaperCard.css` transitions its `height` — so a bar
 * animation that changed a `dvh` bound mid-scroll would snap the clamp
 * instead of easing it, and could yank the scroll position with it. `svh`
 * pins the bound to the viewport's smallest state so it never moves under an
 * open, actively-scrolled list, at the cost of not reclaiming the extra room
 * once the bar hides — the safer trade for a live scroll container.
 */
function CommandList({ className, ...props }) {
  return (
    <CommandPrimitive.List
      className={cn('max-h-[60svh] overflow-y-auto overflow-x-hidden p-1', className)}
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
 * A result row, and the mark that says the arrow keys are on it.
 *
 * The tint alone was never an indicator: measured in the browser with the
 * palette open, it computes `rgb(26, 29, 36)` over the sheet's
 * `rgb(22, 25, 31)` — 1.04:1 on ink, 1.07:1 on paper, against the 3:1 WCAG
 * 1.4.11 asks of the visual information that identifies a component's state.
 * The tint stays because it makes the row read as one object, but the thing
 * you actually see is the rule.
 *
 * The mark has changed twice. A full 2px ring around the row went because,
 * with the search field's own focus box directly above it, two boxes read as
 * noise (user feedback, 2026-08-29); the 3px inset bar down the left edge
 * that replaced it went because a reader asked for no edge at all on the
 * selected row (2026-10-10). What marks it now is an "↵" at the row's end —
 * the palette's own "Enter opens this" — in `var(--focus-ring)`, the token
 * whose job is "you are here" and whose value stays above 3:1 on every
 * surface in both themes (contrast.test.js measures it). A stronger tint and
 * semibold text make the row read as one object; neither is the indicator.
 * The "↵" carries empty alt text (`content: '↵' / ''`), so it is seen but
 * never read into the option's name.
 * Rows are square: nothing on them is rounded any more. cmdk keeps DOM focus
 * on the field and moves rows via `aria-activedescendant`, so no real focus
 * ring is being hidden.
 */
function CommandItem({ className, ...props }) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-3 px-2 py-2 text-sm',
        'data-[selected=true]:bg-[color-mix(in_srgb,var(--text-primary)_10%,var(--bg-card))] data-[selected=true]:font-semibold',
        "data-[selected=true]:after:ms-auto data-[selected=true]:after:shrink-0 data-[selected=true]:after:ps-2 data-[selected=true]:after:text-[0.8125rem] data-[selected=true]:after:text-[var(--focus-ring)] data-[selected=true]:after:content-['↵'_/_'']",
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
};
