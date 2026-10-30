import { toast } from 'sonner';


export function toastError(title: Parameters<typeof toast.error>[0], options?: Parameters<typeof toast.error>[1]) {
  return toast.error(title, { duration: Infinity, closeButton: true, ...options });
}

/**
 * Escape puts away the toasts that stay until they are closed. Such a toast
 * (an error) on a phone sits at the top, over the page's back, Follow and
 * Share. Its close button comes before the page in the tab order, so a reader
 * whose focused control it covered had to move focus away to reach it and see
 * that control (WCAG 2.4.11). Sonner's own Escape only collapses an expanded
 * stack and never dismisses a toast. Toasts that leave on their own (an Undo, a
 * loading message) are kept. An Escape something else already took (a
 * dialog, menu or sheet, which Base UI cancels; the search field clearing its
 * query) is left alone, so it does that and keeps the toast.
 */
function dismissToastsOnEscape(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'>) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  dismissPersistentToasts();
}

/** Mounted once, by the Toaster; returns the way to stop listening. */
export function listenForToastEscape(target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
  target.addEventListener('keydown', dismissToastsOnEscape);
  return () => target.removeEventListener('keydown', dismissToastsOnEscape);
}

/** Puts away the toasts that stay until they are closed, and keeps those that leave on their own. */
function dismissPersistentToasts() {
  for (const shown of toast.getToasts()) {
    if ('duration' in shown && shown.duration === Infinity) toast.dismiss(shown.id);
  }
}
