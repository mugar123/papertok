import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * The modal dialog — shadcn's Base UI dialog, drawn in this project's
 * vocabulary: an ink scrim, a white sheet with a hairline and the large
 * shadow, near-square corners. Base UI owns what a hand-rolled focus hook used to:
 * the focus trap, Escape, outside-press dismissal, focus restoration and
 * nested dialogs (the stack). `aria-modal="true"` is written here — Base UI
 * makes the page behind inert but does not write the attribute, and
 * FeedContainer's scroll guard and screen readers both read it.
 *
 * Motion is spelled with the keyframes `styles/variables.css` already
 * defines (`fadeIn`/`fadeOut`, `dialogIn`/`dialogOut`), on Base UI's own
 * attributes: `[data-open]` is the arrival, `[data-closed]` the leave. It
 * has to be an `animation`, not a `transition`, for the same reason the
 * palette's own stylesheet says: `getAnimations()` is how the primitive
 * knows to hold the node until the leave has played. `dialogIn`/`dialogOut`
 * animate `opacity` and the native `scale`, never `transform`/`translate`,
 * because the sheet is centred with Tailwind's `translate` utilities and a
 * keyframe touching them would drag it to the corner mid-animation.
 * `motion-safe:` keeps both out of a reduced-motion session, as everywhere
 * else in this repo.
 */
function Dialog(props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/* No `backdrop-blur` on the scrim: its own opacity is what the fade
   animates, and a blur under an animated opacity is re-resolved every frame
   — the mobile-GPU cost this repo's other backdrops were cleared of. */
function DialogOverlay({ className, ...props }) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
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

/**
 * `overlayClassName` lets a dialog time its own scrim (the palette leaves
 * more slowly than the 150ms above). `initialFocus` / `finalFocus` reach
 * the popup: a dialog that should open on its first field rather than on
 * its close button says so here. `closeLabel` is the accessible name of the
 * X, in the active language — it is bilingual copy like everything else.
 */
function DialogContent({ className, children, showClose = true, showCloseButton, closeLabel = 'Close', overlayClassName, ...props }) {
  const withClose = showCloseButton ?? showClose;
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        aria-modal="true"
        data-slot="dialog-content"
        className={cn(
          'fixed left-1/2 top-1/2 z-[12051] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
          'border border-border bg-card shadow-[var(--shadow-xl)] rounded-xl outline-none',
          'motion-safe:data-open:[animation:dialogIn_180ms_cubic-bezier(0.16,1,0.3,1)]',
          'motion-safe:data-closed:[animation:dialogOut_140ms_ease_both]',
          className,
        )}
        {...props}
      >
        {children}
        {withClose && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={closeLabel}
          >
            <X size={16} aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1 text-left', className)} {...props} />;
}

function DialogFooter({ className, ...props }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-wrap items-center justify-end gap-2', className)}
      {...props}
    />
  );
}

/* Prose is serif (design.md, rule 1): a dialog's headline reads like one. */
function DialogTitle({ className, ...props }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-serif text-[1.35rem] font-semibold leading-tight tracking-[-0.01em] text-foreground', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-[0.8125rem] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
