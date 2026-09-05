import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * A panel that slides in from an edge and does not need a swipe gesture —
 * a positioned Dialog, as Base UI's own guidance puts it (the Drawer next
 * door is the one with gestures and snap points, for the bottom sheets a
 * thumb dismisses). Filters, side rails, a settings tray.
 *
 * The slide keyframes are the repo's `slideInFrom*` / `slideOutTo*`, which
 * animate `transform` — safe here because, unlike the centred Dialog, a
 * sheet is pinned to an edge with `inset-*`, never with `translate`.
 */
function Sheet(props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal(props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-[12050] bg-[rgba(17,19,24,0.4)]',
        'motion-safe:data-open:[animation:fadeIn_150ms_ease]',
        'motion-safe:data-closed:[animation:fadeOut_150ms_ease_both]',
        className,
      )}
      {...props}
    />
  );
}

const SIDE_CLASSES = {
  right: [
    'inset-y-0 right-0 h-full w-[min(420px,calc(100vw-40px))] border-l',
    'motion-safe:data-open:[animation:slideInFromRight_260ms_cubic-bezier(0.16,1,0.3,1)]',
    'motion-safe:data-closed:[animation:slideOutToRight_200ms_ease_both]',
  ],
  left: [
    'inset-y-0 left-0 h-full w-[min(420px,calc(100vw-40px))] border-r',
    'motion-safe:data-open:[animation:slideInFromLeft_260ms_cubic-bezier(0.16,1,0.3,1)]',
    'motion-safe:data-closed:[animation:slideOutToLeft_200ms_ease_both]',
  ],
  top: [
    'inset-x-0 top-0 max-h-[85dvh] border-b',
    'motion-safe:data-open:[animation:slideInFromTop_260ms_cubic-bezier(0.16,1,0.3,1)]',
    'motion-safe:data-closed:[animation:slideOutToTop_200ms_ease_both]',
  ],
  bottom: [
    'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t pb-[var(--inset-bottom)]',
    'motion-safe:data-open:[animation:slideInFromBottom_260ms_cubic-bezier(0.16,1,0.3,1)]',
    'motion-safe:data-closed:[animation:slideOutToBottom_200ms_ease_both]',
  ],
};

function SheetContent({
  className,
  children,
  side = 'right',
  showClose = true,
  showCloseButton,
  closeLabel = 'Close',
  overlayClassName,
  ...props
}) {
  const withClose = showCloseButton ?? showClose;
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Popup
        aria-modal="true"
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-[12051] flex flex-col overflow-y-auto overscroll-contain',
          'border-border bg-card shadow-[var(--shadow-xl)] outline-none',
          ...(SIDE_CLASSES[side] ?? SIDE_CLASSES.right),
          className,
        )}
        {...props}
      >
        {children}
        {withClose && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={closeLabel}
          >
            <X size={16} aria-hidden="true" />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

function SheetFooter({ className, ...props }) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border p-4', className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-serif text-[1.25rem] font-semibold leading-tight tracking-[-0.01em] text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-[0.8125rem] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
