import { toast, type ExternalToast } from 'sonner';

/** How many modal overlays are on screen (`trackModalOverlay`). */
let openModalOverlays = 0;
/** Who is signed in as far as toasts know: a user ID, null for nobody, undefined until auth first answers. */
let signedIn: string | null | undefined;
/** Counts the account changes (`forgetAccountErrors`). */
let account = 0;
/** Errors waiting for the overlays opened after their action started to leave. */
let heldErrors: Array<{ overlaysAtStart: number; show: () => void }> = [];
let heldCount = 0;

/** When an action whose error can come late started (`actionStart`). */
export type ActionStart = { overlays: number; account: number };

/**
 * Noted as an action starts, for `toastError`: how many modal overlays are
 * open, less `leaving`, the overlays that leave with the press (the palette or
 * sheet it was made in, the question it answered), and which account made it.
 */
export function actionStart({ leaving = 0 } = {}): ActionStart {
  return { overlays: Math.max(0, openModalOverlays - leaving), account };
}

/** Whether the account that started an action is still the one signed in. */
export function sameAccount(startedAt: ActionStart) {
  return startedAt.account === account;
}

/**
 * An error toast that stays until it is closed. `startedAt` is
 * `actionStart()` when the action that failed started. An error of an action
 * started before the account changed is never shown: the reader now is
 * someone else, or signed out. When an overlay has opened over that action
 * since, such as the search palette over a page whose Follow settles late, the
 * error waits for it to leave: on a phone it would sit over the overlay,
 * outside its focus trap, where Escape closes the overlay and leaves the
 * toast. Left out, the error belongs to what is on top now, such as an action
 * inside the open dialog, and appears at once, since it is the reader's only
 * answer to that action. It is announced when it appears. The id is returned
 * either way.
 */
export function toastError(title: Parameters<typeof toast.error>[0], { startedAt = actionStart(), ...options }: ExternalToast & { startedAt?: ActionStart } = {}) {
  const errorOptions = { duration: Infinity, closeButton: true, ...options };
  const ownAccount = sameAccount(startedAt);
  if (ownAccount && openModalOverlays <= startedAt.overlays) return toast.error(title, errorOptions);
  heldCount += 1;
  const id = options.id ?? `held-error-${heldCount}`;
  if (ownAccount) heldErrors.push({ overlaysAtStart: startedAt.overlays, show: () => { toast.error(title, { ...errorOptions, id }); } });
  return id;
}

/**
 * Called with whoever auth says is signed in, `uid` or null, each time it
 * says so. When the account changed, by signing out or in, here or in another
 * tab, the errors of what the account before did are not this reader's: puts
 * away those on screen, forgets those waiting for an overlay, and keeps
 * `toastError` from showing those of actions still under way. The same
 * account again, as when the profile load is tried again, keeps them.
 */
export function forgetAccountErrors(uid: string | null) {
  if (uid === signedIn) return;
  signedIn = uid;
  account += 1;
  heldErrors = [];
  dismissPersistentToasts();
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
 * query) is left alone, so it does that and keeps the toast. A control on the
 * page keeps focus, also when the toasts put away were the last and Sonner
 * still remembers a control from an earlier visit to them
 * (`returnFocusFromToasts`).
 */
function dismissToastsOnEscape(doc: Document, event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing'>) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  const focused = doc.activeElement;
  if (focused !== doc.body && !doc.querySelector('[data-sonner-toaster]')?.contains(focused)) returnFocusFromToasts(doc);
  dismissPersistentToasts();
}

/** Mounted once, by the Toaster; returns the way to stop listening. */
export function listenForToastEscape(target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'document'>) {
  const onKeyDown = (event: KeyboardEvent) => { dismissToastsOnEscape(target.document, event); };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

/** Puts away the toasts that stay until they are closed, and keeps those that leave on their own. */
function dismissPersistentToasts() {
  for (const shown of toast.getToasts()) {
    if ('duration' in shown && shown.duration === Infinity) toast.dismiss(shown.id);
  }
}

/**
 * Sonner (2.0.8) remembers the control that had focus when focus entered the
 * toasts (Alt+T, Tab, a press on an action) and focuses it again when focus
 * leaves them, or when the last toast has left. A focused button that leaves
 * with its toast never tells Sonner, so that memory can outlive the visit.
 * Save to list, opened from the "Add to list" action, lost focus to the
 * card's Save behind it (WCAG 2.4.3): Sonner took focus back as the sheet
 * took it from the action, or once the toasts the sheet put away had left.
 * So, as an overlay opens and before it takes focus, Sonner hears that focus
 * has left the toasts. Focus in them, or lost with a toast, goes back to that
 * control now; the overlay takes it from there and returns it there on close.
 * Focus on any other control stays where it is.
 */
function returnFocusFromToasts(doc: Document) {
  const toasts = doc.querySelector('[data-sonner-toaster]');
  if (!toasts) return;
  const focused = doc.activeElement;
  toasts.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  if (focused instanceof HTMLElement && focused !== doc.body && !toasts.contains(focused)) focused.focus({ preventScroll: true });
}

/**
 * The ref of every modal overlay's portal: the dialog, alert dialog, drawer
 * and sheet in this folder, and so the search palette, the reader, save to
 * list, related papers and every confirmation built on them. The portal
 * attaches as the overlay opens, before that frame is painted and before the
 * overlay takes focus, and detaches
 * once its leave has played. On a phone, or at 400% zoom, these overlays cover
 * the screen and trap focus, and an error toast over one sits outside the
 * trap, where Escape closes the overlay and leaves the toast. So opening one
 * puts away the errors raised before it, and `toastError` holds an error
 * whose caller noted `actionStart()` before it opened (the Follow presses)
 * until it leaves. Popovers, tooltips, selects
 * and dropdown menus are anchored to their control and never cover the
 * screen, so they do neither; a menu drawn as a dialog or drawer, such as the
 * paper's More menu or a menu on a phone, counts as an overlay.
 */
export function trackModalOverlay(portal: HTMLElement | null) {
  if (!portal) return undefined;
  returnFocusFromToasts(portal.ownerDocument);
  openModalOverlays += 1;
  dismissPersistentToasts();
  return () => {
    openModalOverlays -= 1;
    const due = heldErrors.filter(held => held.overlaysAtStart >= openModalOverlays);
    heldErrors = heldErrors.filter(held => held.overlaysAtStart < openModalOverlays);
    for (const held of due) held.show();
  };
}
