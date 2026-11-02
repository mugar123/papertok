import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { actionStart, forgetAccountToasts, trackModalOverlay, listenForToastEscape, toastError } from './toast.ts';

// Sonner announces the dismissal of one toast on the next frame; Node has no frames.
globalThis.requestAnimationFrame ??= (callback) => Number(setTimeout(() => callback(0), 0));
globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

const onScreen = (id: string | number) => toast.getToasts().some(shown => shown.id === id);

/**
 * Node has no DOM. A document with what these tests need of one: elements
 * that take focus, moved as a browser moves it (focusout on the element losing
 * it and its ancestors first, with focus on the body meanwhile; a handler that
 * moves focus then wins), and the toast list as Sonner 2.0.8 draws it
 * (node_modules/sonner/dist/index.mjs:1125-1188).
 */
class PageFocusEvent extends Event {
  readonly relatedTarget: EventTarget | null;
  constructor(type: string, init: FocusEventInit = {}) {
    super(type, init);
    this.relatedTarget = init.relatedTarget ?? null;
  }
}

class PageElement extends EventTarget {
  readonly ownerDocument: PageDocument;
  readonly name: string;
  readonly parent: PageElement | null;
  private removed = false;
  private readonly children: PageElement[] = [];
  private readonly attributes = new Set<string>();
  constructor(ownerDocument: PageDocument, name: string, parent: PageElement | null) {
    super();
    this.ownerDocument = ownerDocument;
    this.name = name;
    this.parent = parent;
    parent?.children.push(this);
  }

  setAttribute(name: string) {
    this.attributes.add(name);
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  // Only the overlay's popup is looked up, by its slot; the name stands in for it.
  querySelector(selector: string): PageElement | null {
    assert.equal(selector, '[data-slot$="-content"]');
    for (const child of this.children) {
      const found = child.name.endsWith('-content') ? child : child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  get isConnected(): boolean {
    return !this.removed && (this.parent?.isConnected ?? true);
  }

  contains(other: unknown) {
    let node = other instanceof PageElement ? other : null;
    while (node && node !== this) node = node.parent;
    return node === this;
  }

  focus() {
    this.ownerDocument.moveFocus(this);
  }

  // Focus on a removed element falls to the body unheard: React hears focus
  // events at its root, and the element has left it.
  remove() {
    this.removed = true;
    if (!this.ownerDocument.activeElement.isConnected) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
}

class PageDocument {
  readonly body: PageElement = new PageElement(this, 'body', null);
  activeElement = this.body;
  private toastList: PageElement | null = null;

  element(name: string, parent = this.body) {
    return new PageElement(this, name, parent);
  }

  querySelector(selector: string) {
    return selector === '[data-sonner-toaster]' && this.toastList?.isConnected ? this.toastList : null;
  }

  moveFocus(target: PageElement) {
    const from = this.activeElement;
    if (target === from || !target.isConnected) return;
    this.activeElement = this.body;
    for (let node = from === this.body ? null : from; node; node = node.parent) {
      node.dispatchEvent(new PageFocusEvent('focusout', { relatedTarget: target }));
    }
    if (this.activeElement !== this.body) return;
    this.activeElement = target;
    for (let node: PageElement | null = target; node; node = node.parent) {
      node.dispatchEvent(new PageFocusEvent('focusin', { relatedTarget: from === this.body ? null : from }));
    }
  }

  /**
   * Sonner's toast list: focus entering it notes the control it came from,
   * and focus leaving it, or the list leaving once its last toast has gone
   * (`leave`), focuses that control again.
   */
  toasts() {
    const list = this.element('toasts');
    this.toastList = list;
    let focusWithin = false;
    let cameFrom: PageElement | null = null;
    const relatedTarget = (event: Event) => (event instanceof PageFocusEvent ? event.relatedTarget : null);
    list.addEventListener('focusin', (event) => {
      if (focusWithin) return;
      focusWithin = true;
      const from = relatedTarget(event);
      cameFrom = from instanceof PageElement ? from : null;
    });
    list.addEventListener('focusout', (event) => {
      if (!focusWithin || list.contains(relatedTarget(event))) return;
      focusWithin = false;
      cameFrom?.focus();
      cameFrom = null;
    });
    const leave = () => {
      list.remove();
      if (!cameFrom) return;
      cameFrom.focus();
      cameFrom = null;
      focusWithin = false;
    };
    return { list, leave };
  }
}

// The document's elements and focus events stand in for the DOM's.
Object.assign(globalThis, { HTMLElement: PageElement, FocusEvent: PageFocusEvent });

/**
 * The window as the Toaster listens to it: `taken` is a listener that handles
 * the key first, as a dialog, a menu or the search field clearing its query
 * does (`preventDefault`).
 */
function page({ taken = false, doc = new PageDocument() } = {}) {
  const target = Object.assign(new EventTarget(), { document: doc as unknown as Document });
  if (taken) target.addEventListener('keydown', (event) => { event.preventDefault(); });
  const stop = listenForToastEscape(target);
  const press = (key: string, { isComposing = false } = {}) => {
    target.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key, isComposing }));
  };
  return { press, stop };
}

/**
 * An error toast stays until it is closed, and on a phone it can cover the
 * control that has focus. Escape has to reveal that control without moving
 * focus (WCAG 2.4.11), unless a dialog or menu already took the key.
 */
test('Escape puts away an error toast that stays until it is closed', () => {
  const { press, stop } = page();
  const id = toastError('Could not follow Nature. Try again.');
  assert.ok(onScreen(id), 'the toast is on screen');
  press('Escape');
  assert.ok(!onScreen(id), 'Escape dismissed it');
  stop();
});

test('an Escape a dialog or menu already took, another key, or one that ends a composition leaves the toast', () => {
  const id = toastError('Could not follow Nature. Try again.');
  const taken = page({ taken: true });
  taken.press('Escape');
  taken.stop();
  const plain = page();
  plain.press('Enter');
  plain.press('Escape', { isComposing: true });
  plain.stop();
  assert.ok(onScreen(id), 'the toast is still on screen');
  toast.dismiss();
});

test('Escape keeps the toasts that leave on their own, such as an Undo or a loading message', () => {
  const { press, stop } = page();
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const loading = toast.loading('Saving');
  const error = toastError('Could not follow Nature. Try again.');
  press('Escape');
  assert.ok(onScreen(undo), 'the Undo toast is still on screen');
  assert.ok(onScreen(loading), 'the loading toast is still on screen');
  assert.ok(!onScreen(error), 'the error toast was put away');
  stop();
  toast.dismiss();
});

/**
 * A dialog, alert dialog, drawer or sheet fills a phone's screen and traps
 * focus; an error toast raised before it opened sat over it, outside the trap,
 * and Escape there closes the overlay, not the toast. Each overlay's portal
 * takes this ref, which Base UI calls with the portal's element as the overlay
 * opens, and whose returned cleanup it calls once the overlay has left.
 * `startLeaving` marks its popup closed, as Base UI does when the leave starts.
 */
function openOverlay() {
  const doc = new PageDocument();
  const portal = doc.element('portal');
  const popup = doc.element('dialog-content', portal);
  const close = trackModalOverlay(portal as unknown as HTMLElement)!;
  return Object.assign(close, { startLeaving: () => { popup.setAttribute('data-closed'); } });
}

test('opening an overlay puts away the toasts that stay until closed, keeping the ones that leave on their own', () => {
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const errors = [toastError('Could not follow Nature. Try again.'), toastError('The list could not be deleted')];
  const close = openOverlay();
  assert.ok(onScreen(undo), 'the Undo toast is still on screen');
  assert.deepEqual(errors.map(onScreen), [false, false], 'both error toasts were put away');
  close();
  assert.deepEqual(errors.map(onScreen), [false, false], 'closing the overlay does not bring them back');
  toast.dismiss();
});

// A Follow pressed on a page settles after the palette, or any other modal
// overlay, opened: its refusal waits for the overlays opened since to leave.
test('an error of an action started behind overlays opened since appears once they have left', () => {
  const closeSheet = openOverlay();
  const startedAt = actionStart();
  const closePalette = openOverlay();
  const closeConfirmation = openOverlay();
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  assert.ok(!onScreen(error), 'nothing sits over the overlays opened after the press');
  closeConfirmation();
  assert.ok(!onScreen(error), 'the palette is still open');
  closePalette();
  assert.ok(onScreen(error), 'the error is on screen once both have left, over the sheet it was pressed in');
  closeSheet();
  toast.dismiss();
});

// Follow pressed on an Explorer journal page as the reader over it plays its
// leave; the palette opens before the refusal arrives, and the reader's
// portal detaches meanwhile.
test('an overlay still leaving at the press does not count as open before it', () => {
  const closeReader = openOverlay();
  closeReader.startLeaving();
  const startedAt = actionStart();
  const closePalette = openOverlay();
  closeReader();
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  assert.ok(!onScreen(error), 'nothing sits over the palette opened after the press');
  closePalette();
  assert.ok(onScreen(error), 'the error is on screen once the palette has left');
  toast.dismiss();
});

// Creating a public list in the save dialog whose publishing fails: the toast
// is the only answer to that action, so it must not wait for the dialog.
test('an error of an action taken in the open overlay appears at once', () => {
  const closeSaveDialog = openOverlay();
  const error = toastError('List created, but still private');
  assert.ok(onScreen(error), 'the error is on screen over its own dialog');
  closeSaveDialog();
  toast.dismiss();
});

// The save dialog closes as its list's publishing fails: "List created, but
// still private" is raised while the dialog plays its leave.
test('an error raised while the overlay over it plays its leave appears at once', () => {
  const closeSaveDialog = openOverlay();
  closeSaveDialog.startLeaving();
  const error = toastError('List created, but still private');
  assert.ok(onScreen(error), 'the error is on screen during the leave');
  closeSaveDialog();
  toast.dismiss();
});

// A Follow's refusal settles while the palette opened after the press is
// already leaving.
test('an error of an action started behind an overlay that is leaving now appears at once', () => {
  const startedAt = actionStart();
  const closePalette = openOverlay();
  closePalette.startLeaving();
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  assert.ok(onScreen(error), 'the error is on screen during the leave');
  closePalette();
  toast.dismiss();
});

test('an error of an action whose overlay has closed since appears at once', () => {
  const closePalette = openOverlay();
  const startedAt = actionStart();
  closePalette();
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  assert.ok(onScreen(error), 'the error is on screen');
  toast.dismiss();
});

// Auth says who is signed in; each call here names someone new.
let readers = 0;
const switchAccount = () => { readers += 1; forgetAccountToasts(`reader-${readers}`); };

// Signed out from the account menu while a Follow's refusal waited behind it.
test('an error still waiting when the account changes is never shown', () => {
  const startedAt = actionStart();
  const closeAccountMenu = openOverlay();
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  switchAccount();
  closeAccountMenu();
  assert.ok(!onScreen(error), 'the reader signed in next does not see it');
});

// Signed out, here or in another tab, while a Follow's write was still under
// way: its refusal settles when someone else, or nobody, is signed in.
test('an error of an action started before the account changed is never shown', () => {
  const startedAt = actionStart();
  switchAccount();
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  assert.ok(!onScreen(error), 'the reader now does not see it');
  const startedBehindPalette = actionStart();
  const closePalette = openOverlay();
  switchAccount();
  const held = toastError('Could not follow Nature. Try again.', { startedAt: startedBehindPalette });
  closePalette();
  assert.ok(!onScreen(held), 'nor once the overlay opened since has left');
});

test('an error on screen when the account changes is put away', () => {
  const error = toastError('Could not follow Nature. Try again.');
  switchAccount();
  assert.ok(!onScreen(error), 'the reader signed in next does not see it');
});

// Unfollowed Nature, then signed into another account in another tab within
// the Undo's few seconds: pressed here, the Undo would follow Nature for them.
test('a toast with an action on screen when the account changes is put away, a plain one stays', () => {
  const undo = toast('Unfollowed Nature', { action: { label: 'Undo', onClick: () => {} } });
  const addToList = toast.success('Saved to Read later', { action: { label: 'Add to list', onClick: () => {} } });
  const plain = toast.success('Link copied');
  switchAccount();
  assert.deepEqual([undo, addToList].map(onScreen), [false, false], 'their actions were the account before');
  assert.ok(onScreen(plain), 'a toast without an action stays');
  toast.dismiss();
});

// "Try again" on the profile error screen listens to auth again, and auth
// names the same reader again while their Follow is still under way.
test('auth naming the same reader again keeps their errors', () => {
  switchAccount();
  const onScreenBefore = toastError('The list could not be deleted');
  const startedAt = actionStart();
  forgetAccountToasts(`reader-${readers}`);
  const error = toastError('Could not follow Nature. Try again.', { startedAt });
  assert.ok(onScreen(onScreenBefore), 'the error already on screen stays');
  assert.ok(onScreen(error), 'the refusal of their own press is shown');
  toast.dismiss();
});

test('an error raised with no overlay open appears at once', () => {
  openOverlay()();
  const error = toastError('The list could not be deleted');
  assert.ok(onScreen(error), 'the error toast is on screen');
  toast.dismiss();
});

/**
 * A sheet opening on `doc` as Base UI opens one: its portal attaches first;
 * its popup mounts next and notes what has focus, to return it there on
 * close; a frame later it takes focus.
 */
function openSheet(doc: PageDocument) {
  const portal = doc.element('portal');
  const untrack = trackModalOverlay(portal as unknown as HTMLElement)!;
  const returnTo = doc.activeElement;
  doc.element('Save to list', portal).focus();
  return () => {
    untrack();
    portal.remove();
    returnTo.focus();
  };
}

/**
 * The card's Save shows "Saved to Read later" with "Add to list", while an
 * error toast stays from earlier. The reader moves focus into the toasts
 * (Alt+T, Tab) and onto "Add to list".
 */
function savedToastWithError() {
  const doc = new PageDocument();
  const save = doc.element('Save');
  const { list, leave } = doc.toasts();
  const addToList = doc.element('Add to list', list);
  save.focus();
  addToList.focus();
  return { doc, addToList, leave };
}

// Enter on "Add to list" opens Save to list; the Saved toast leaves with its
// action, and the error toast, put away as the sheet opened, was the last.
test('an overlay opened from a toast action keeps focus when the toasts leave, and returns it to the control used before the toasts', () => {
  const { doc, addToList, leave } = savedToastWithError();
  const close = openSheet(doc);
  addToList.remove();
  leave();
  assert.equal(doc.activeElement.name, 'Save to list', 'focus is in the sheet, not on Save behind it');
  close();
  assert.equal(doc.activeElement.name, 'Save', 'closing the sheet returns focus to Save');
});

// Opened late (its code still loading, or frames held back in a hidden tab):
// the Saved toast and its focused action left first, and focus fell to the
// body unheard.
test('an overlay opened after the toast whose action had focus left keeps focus when the last toast leaves', () => {
  const { doc, addToList, leave } = savedToastWithError();
  addToList.remove();
  const close = openSheet(doc);
  leave();
  assert.equal(doc.activeElement.name, 'Save to list', 'focus is in the sheet');
  close();
  assert.equal(doc.activeElement.name, 'Save', 'closing the sheet returns focus to Save');
});

test('an overlay opened from a page control after that toast left keeps focus, and returns it to that control', () => {
  const { doc, addToList, leave } = savedToastWithError();
  addToList.remove();
  doc.element('Filters').focus();
  const close = openSheet(doc);
  leave();
  assert.equal(doc.activeElement.name, 'Save to list', 'focus is in the sheet');
  close();
  assert.equal(doc.activeElement.name, 'Filters', 'closing the sheet returns focus to Filters');
});

// The same visit to the toasts, then Escape on Filters puts away the error
// toast, which was the last.
test('Escape on a page control keeps focus there when the toasts it puts away were the last', () => {
  const { doc, addToList, leave } = savedToastWithError();
  addToList.remove();
  doc.element('Filters').focus();
  const { press, stop } = page({ doc });
  toastError('Could not follow Nature. Try again.');
  press('Escape');
  leave();
  assert.equal(doc.activeElement.name, 'Filters', 'focus stays on Filters, not on Save');
  stop();
  toast.dismiss();
});

test('once the Toaster stops listening, Escape leaves the toast', () => {
  const { press, stop } = page();
  stop();
  const id = toastError('Could not follow Nature. Try again.');
  press('Escape');
  assert.ok(onScreen(id), 'the toast is still on screen');
  toast.dismiss();
});
