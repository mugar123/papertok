import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { cn } from '../../lib/utils.js';
import { Button } from './button.jsx';

/**
 * A dialog that interrupts: `role="alertdialog"`, no outside-press dismissal,
 * the answer has to be one of its buttons. For confirmations with a cost —
 * deleting an account, discarding a draft. Same sheet and motion as Dialog.
 */
function AlertDialog(props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal(props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
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

function AlertDialogContent({ className, overlayClassName, ...props }) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay className={overlayClassName} />
      <AlertDialogPrimitive.Popup
        aria-modal="true"
        data-slot="alert-dialog-content"
        className={cn(
          'fixed left-1/2 top-1/2 z-[12051] w-full max-w-md -translate-x-1/2 -translate-y-1/2',
          'border border-border bg-card shadow-[var(--shadow-xl)] rounded-xl outline-none',
          'motion-safe:data-open:[animation:dialogIn_180ms_cubic-bezier(0.16,1,0.3,1)]',
          'motion-safe:data-closed:[animation:dialogOut_140ms_ease_both]',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }) {
  return <div data-slot="alert-dialog-header" className={cn('flex flex-col gap-1 text-left', className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-wrap items-center justify-end gap-2', className)}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('font-serif text-[1.35rem] font-semibold leading-tight tracking-[-0.01em] text-foreground', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-[0.8125rem] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

/* Both buttons are Close parts: the difference is which one the caller
   wires an action to. `variant` passes through to the shared Button. */
function AlertDialogAction({ variant = 'default', ...props }) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-action"
      render={<Button variant={variant} />}
      {...props}
    />
  );
}

function AlertDialogCancel({ variant = 'outline', ...props }) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      render={<Button variant={variant} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
