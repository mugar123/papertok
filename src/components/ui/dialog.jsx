import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;
const DialogTitle = DialogPrimitive.Title;
const DialogDescription = DialogPrimitive.Description;

// The shadcn source these primitives come from fades the overlay with
// `animate-in` / `animate-out`, which are utilities of the `tailwindcss-animate`
// plugin — not of Tailwind itself. That plugin is not a dependency here, so
// those classes generated no rule at all and the overlay appeared and vanished
// in one frame. Adding the plugin for one fade would be a whole dependency for
// a shorthand the repo does not otherwise use, so the fade is spelled with the
// `fadeIn` / `fadeOut` keyframes `src/styles/variables.css` already defines and
// `CreateListDialog.css` already fades its backdrop with, at the same 0.15s.
//
// It has to be an `animation` rather than a `transition`: @radix-ui/react-presence
// only defers unmount while `getComputedStyle(node).animationName` is not
// `none`, so a transitioned exit would be cut off by the unmount. `both` holds
// the last frame so the overlay cannot flash back to full opacity before it
// goes. `motion-safe:` keeps both out of a reduced-motion session, which is how
// every other animation in this repo is guarded.
//
// No `backdrop-blur-*` here: this overlay's own opacity is what `fadeIn`/
// `fadeOut` animate, and a blur underneath an animated opacity is
// re-resolved every frame — the same mobile-GPU cost this repo's other
// backdrops were cleared of. The rgba veil alone reads as the backdrop.
function DialogOverlay({ className, ...props }) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-[12050] bg-[rgba(17,19,24,0.4)]',
        'motion-safe:data-[state=open]:[animation:fadeIn_150ms_ease]',
        'motion-safe:data-[state=closed]:[animation:fadeOut_150ms_ease_both]',
        className,
      )}
      {...props}
    />
  );
}

// `overlayClassName` lets a dialog time its own scrim: the palette leaves
// more slowly than the 150ms above, and a ground that clears before the sheet
// is the "vanished" look this fade exists to prevent.
function DialogContent({ className, children, showClose = true, overlayClassName, ...props }) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[12051] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
          'border border-border bg-card shadow-[var(--shadow-xl)] rounded-xl',
          // The sheet itself arrives and leaves; only the overlay used to,
          // so the palette popped in and vanished in one frame (reported
          // from a real iPhone, 2026-08-29). Same radix-Presence contract
          // as the overlay above: an `animation` with `both`, so the exit
          // is not cut off by the unmount. The keyframes animate `scale`,
          // never `transform`/`translate` — see their comment in
          // variables.css for why that distinction is load-bearing.
          'motion-safe:data-[state=open]:[animation:dialogIn_180ms_cubic-bezier(0.16,1,0.3,1)]',
          'motion-safe:data-[state=closed]:[animation:dialogOut_140ms_ease_both]',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X size={16} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
