import { toast } from 'sonner';


export function toastError(title: Parameters<typeof toast.error>[0], options?: Parameters<typeof toast.error>[1]) {
  return toast.error(title, { duration: Infinity, closeButton: true, ...options });
}

/**
 * Escape puts the toasts away. An error toast stays until it is closed, and on
 * a phone it sits at the top, over the page's back, Follow and Share; its
 * close button is a Tab away, so a reader whose focused control it covered
 * had to move focus to see it (WCAG 2.4.11). Sonner's own Escape only works
 * from inside the toast. An Escape an open dialog, menu or sheet already took
 * (Base UI cancels it) is left alone, so it closes that and keeps the toast.
 */
export function dismissToastsOnEscape(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'>) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  toast.dismiss();
}
