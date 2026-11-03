import { toast, type ExternalToast } from 'sonner';

/** The portal of each modal overlay on screen, those leaving included (`trackModalOverlay`). */
const overlayPortals = new Set<HTMLElement>();
/** Who is signed in as far as toasts know: a user ID, null for nobody, undefined until auth first answers. */
let signedIn: string | null | undefined;
/** Counts the account changes (`forgetAccountToasts`). */
let account = 0;
/** Errors and refusal lines waiting for the overlays opened after their action started to leave. */
let held: Array<{ overlaysAtStart: number; show: () => void }> = [];
let heldCount = 0;

/** When an action whose error can come late started (`actionStart`). */
export type ActionStart = { overlays: number; account: number };

/**
 * Whether an overlay has started to leave: Base UI marks its popup, the
 * portal's first `*-content` slot, closed as the leave starts, and detaches
 * the portal once the leave has played.
 */
function isLeaving(portal: HTMLElement) {
  return portal.querySelector('[data-slot$="-content"]')?.hasAttribute('data-closed') ?? false;
}

/**
 * How many modal overlays are open, those already leaving left out: one
 * leaving is on its way out and no longer holds anything back.
 */
function openOverlays() {
  return [...overlayPortals].filter(portal => !isLeaving(portal)).length;
}

/**
 * Noted as an action starts, for `toastError`: how many modal overlays are
 * open, less those already leaving and `leaving`, the overlays that leave
 * with the press (the palette or sheet it was made in, the question it
 * answered), and which account made it. A leaving overlay counted here would
 * let an overlay opened after the press pass for one open before it.
 */
export function actionStart({ leaving = 0 } = {}): ActionStart {
  return { overlays: Math.max(0, openOverlays() - leaving), account };
}

/** Whether the account that started an action is still the one signed in. */
export function sameAccount(startedAt: ActionStart) {
  return startedAt.account === account;
}

/**
 * Calls `show` once no overlay opened after the action of `startedAt` is
 * open: at once when none is, or else as the last of them leaves. Never for
 * an action started before the account changed. `inOverlay` says `show` draws
 * inside an overlay that `startedAt` left out because the press leaves with
 * it, such as the search palette or the Follows sheet whose refusal line it
 * writes: while that overlay is open it holds nothing back.
 */
export function afterOverlaysSince(startedAt: ActionStart, show: () => void, { inOverlay = false } = {}) {
  if (!sameAccount(startedAt)) return;
  const overlaysAtStart = startedAt.overlays + Number(inOverlay);
  if (openOverlays() <= overlaysAtStart) show();
  else held.push({ overlaysAtStart, show });
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
 * answer to that action. An overlay already playing its leave holds nothing
 * back. It is announced when it appears. The id is returned
 * either way.
 */
export function toastError(title: Parameters<typeof toast.error>[0], { startedAt = actionStart(), ...options }: ExternalToast & { startedAt?: ActionStart } = {}) {
  const errorOptions = { duration: Infinity, closeButton: true, ...options };
  if (sameAccount(startedAt) && openOverlays() <= startedAt.overlays) return toast.error(title, errorOptions);
  heldCount += 1;
  const id = options.id ?? `held-error-${heldCount}`;
  afterOverlaysSince(startedAt, () => { toast.error(title, { ...errorOptions, id }); });
  return id;
}

/**
 * Called with whoever auth says is signed in, `uid` or null, each time it
 * says so. When the account changed, by signing out or in, here or in another
 * tab, the errors of what the account before did are not this reader's, and
 * an Undo or other action on a toast would act for the reader now: puts away
 * the error toasts and those with an action, forgets the errors and refusal
 * lines waiting for an overlay, and keeps `toastError` from showing those of
 * actions still under way. The same account again, as when the profile load
 * is tried again, keeps them.
 */
export function forgetAccountToasts(uid: string | null) {
  if (uid === signedIn) return;
  signedIn = uid;
  account += 1;
  held = [];
  for (const shown of toast.getToasts()) {
    if (('duration' in shown && shown.duration === Infinity) || ('action' in shown && shown.action)) toast.dismiss(shown.id);
  }
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
 * puts away the errors raised before it, and `afterOverlaysSince` holds an
 * error or refusal line whose caller noted `actionStart()` before it opened
 * (the Follow presses) until it leaves. Popovers, tooltips, selects
 * and dropdown menus are anchored to their control and never cover the
 * screen, so they do neither; a menu drawn as a dialog or drawer, such as the
 * paper's More menu or a menu on a phone, counts as an overlay.
 */
export function trackModalOverlay(portal: HTMLElement | null) {
  if (!portal) return undefined;
  returnFocusFromToasts(portal.ownerDocument);
  overlayPortals.add(portal);
  dismissPersistentToasts();
  return () => {
    overlayPortals.delete(portal);
    const open = openOverlays();
    const due = held.filter(waiting => waiting.overlaysAtStart >= open);
    held = held.filter(waiting => waiting.overlaysAtStart < open);
    for (const waiting of due) waiting.show();
  };
}
