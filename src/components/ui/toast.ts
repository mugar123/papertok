import { toast } from 'sonner';

/** How many modal overlays are on screen (`trackModalOverlay`). */
let openModalOverlays = 0;
/** The error toasts raised while one was, shown once the last one leaves. */
let heldErrors: Array<() => void> = [];
let heldCount = 0;

/**
 * An error toast that stays until it is closed. Raised while a modal overlay
 * is open, it waits for the last one to leave: on a phone it would sit over
 * the overlay, outside its focus trap, where Escape closes the overlay and
 * leaves the toast. It is announced when it appears. The id is returned
 * either way.
 */
export function toastError(title: Parameters<typeof toast.error>[0], options?: Parameters<typeof toast.error>[1]) {
  const errorOptions = { duration: Infinity, closeButton: true, ...options };
  if (openModalOverlays === 0) return toast.error(title, errorOptions);
  heldCount += 1;
  const id = options?.id ?? `held-error-${heldCount}`;
  heldErrors.push(() => { toast.error(title, { ...errorOptions, id }); });
  return id;
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

/**
 * The ref of every modal overlay's portal: the dialog, alert dialog, drawer
 * and sheet in this folder, and so the search palette, the reader, save to
 * list, related papers and every confirmation built on them. The portal
 * attaches as the overlay opens, before that frame is painted, and detaches
 * once its leave has played. On a phone, or at 400% zoom, these overlays cover
 * the screen and trap focus, and an error toast over one sits outside the
 * trap, where Escape closes the overlay and leaves the toast. So opening one
 * puts away the errors raised before it, and `toastError` holds those raised
 * while one is open until the last one leaves. Popovers, menus and tooltips
 * are anchored to their control and never cover the screen, so they do
 * neither.
 */
export function trackModalOverlay(portal: HTMLElement | null) {
  if (!portal) return undefined;
  openModalOverlays += 1;
  dismissPersistentToasts();
  return () => {
    openModalOverlays -= 1;
    if (openModalOverlays > 0) return;
    const held = heldErrors;
    heldErrors = [];
    for (const show of held) show();
  };
}
