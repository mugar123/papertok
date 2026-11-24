import type { ToastT } from 'sonner';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { followName, followRefusal, refusalShownTo, sayFollowRefused, toastFollowRefused, toggleFollowOrRefusal } from './follow-refused-toast.ts';
import { actionStart, forgetAccountToasts, trackModalOverlay } from '../ui/toast.ts';

/** The toast `id` put on screen, as the Toaster would render it. */
function shown(id: string | number) {
  const item = toast.getToasts().find((entry): entry is ToastT => entry.id === id && !('dismiss' in entry && entry.dismiss));
  assert.ok(item, 'a toast was raised');
  const action = item.action && typeof item.action === 'object' && 'onClick' in item.action ? item.action : null;
  return { title: item.title, type: item.type, duration: item.duration, closeButton: item.closeButton, action };
}

// A write the rules refuse, or one that fails for any other reason: the
// Follow toggle flips back, and says so. The toast stays until it is closed.
test('a refusal says what was not done, for a follow and for an unfollow', (t) => {
  t.mock.method(console, 'error', () => {});
  const follow = shown(toastFollowRefused(new Error('PERMISSION_DENIED'), { name: 'Econometrica', following: false }));
  assert.deepEqual([follow.title, follow.type, follow.duration, follow.closeButton], ['Could not follow Econometrica. Try again.', 'error', Infinity, true]);
  const unfollow = shown(toastFollowRefused(new Error('unavailable'), { name: 'Ada Lovelace', following: true }));
  assert.equal(unfollow.title, 'Could not unfollow Ada Lovelace. Try again.');
});

// The search palette fills a phone's screen, and a toast at the top covered its
// first row's Follow outside the dialog's focus trap. It says the refusal in
// its own warning line instead: the same words, and no toast.
test('a refusal for the search palette raises no toast and keeps the words', (t) => {
  t.mock.method(console, 'error', () => {});
  const before = toast.getToasts().filter(entry => !('dismiss' in entry && entry.dismiss)).length;
  const refused = followRefusal(new Error('PERMISSION_DENIED'), { name: 'Ada Lovelace', following: true });
  assert.deepEqual(refused, { message: 'Could not unfollow Ada Lovelace. Try again.' });
  assert.equal(toast.getToasts().filter(entry => !('dismiss' in entry && entry.dismiss)).length, before, 'no toast was raised');
});

// The palette's rows hand over `name`, the Search page's `displayName`; a
// refusal named "this" left a screen-reader user guessing which row it meant.
test('a refused press names the row, whichever field its surface filled', async (t) => {
  t.mock.method(console, 'error', () => {});
  const refuse = (following: boolean) => ({
    isFollowing: () => following,
    toggleFollow: () => Promise.reject(new Error('PERMISSION_DENIED')),
  });
  const said = async (entity: Parameters<typeof toggleFollowOrRefusal>[0], following = false) => (await toggleFollowOrRefusal(entity, refuse(following)))?.message;
  assert.deepEqual(await Promise.all([
    said({ type: 'author', id: 'https://openalex.org/A1', name: 'Ada Lovelace' }),
    said({ type: 'institution', id: 'https://openalex.org/I1', name: 'University of Salamanca' }, true),
    said({ type: 'concept', id: 'https://openalex.org/C1', name: 'Cosmology' }),
    said({ type: 'author', id: 'https://openalex.org/A2', displayName: 'Grace Hopper' }),
    said({ type: 'topic', id: 'T1', display_name: 'Econometrics' }),
    said({ type: 'topic', canonicalId: 'physics', displayName: 'Física' }, true),
  ]), [
    'Could not follow Ada Lovelace. Try again.',
    'Could not unfollow University of Salamanca. Try again.',
    'Could not follow Cosmology. Try again.',
    'Could not follow Grace Hopper. Try again.',
    'Could not follow Econometrics. Try again.',
    'Could not unfollow Physics. Try again.',
  ]);
  assert.equal(followName({ type: 'author', id: 'A3', displayName: 'Rosalind Franklin' }), 'Rosalind Franklin');
});

// Opening an overlay dismisses toasts, which Sonner announces on the next frame; Node has no frames.
globalThis.requestAnimationFrame ??= (callback) => Number(setTimeout(() => callback(0), 0));
globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);

// An overlay's portal ref, as Base UI calls it on opening; the cleanup closes
// it. Node has no DOM: the portal's page draws no toast list, and the portal
// finds no popup marked closed, so it stays open until then.
const openOverlay = () => trackModalOverlay({ ownerDocument: { querySelector: () => null }, querySelector: () => null } as unknown as HTMLElement)!;
// The ids of the toasts on screen that were not in `before`.
const newToasts = (before: Set<string | number>) => toast.getToasts()
  .filter(entry => !before.has(entry.id) && !('dismiss' in entry && entry.dismiss))
  .map(entry => entry.id);

test('a refusal in the palette or the Follows list, while it is on screen, goes to its own line and raises no toast', () => {
  const before = new Set(toast.getToasts().map(entry => entry.id));
  const closePalette = openOverlay();
  const lines: string[] = [];
  sayFollowRefused({ message: 'Could not follow Ada Lovelace. Try again.' }, {
    inView: () => true, inOverlay: true, showInLine: refused => lines.push(refused.message), startedAt: actionStart({ leaving: 1 }),
  });
  assert.deepEqual(lines, ['Could not follow Ada Lovelace. Try again.']);
  assert.equal(newToasts(before).length, 0, 'no toast was raised');
  closePalette();
});

// Follow pressed in the palette, which the reader closes and then opens a
// paper's More drawer before the write is refused: the toast must not sit
// over that drawer, outside its focus trap.
test('a refusal settling after the list closed waits for an overlay opened since, then shows in a toast', () => {
  const before = new Set(toast.getToasts().map(entry => entry.id));
  const closePalette = openOverlay();
  const startedAt = actionStart({ leaving: 1 });
  closePalette();
  const closeDrawer = openOverlay();
  sayFollowRefused({ message: 'Could not follow Ada Lovelace. Try again.' }, {
    inView: () => false, showInLine: () => assert.fail('the line is not on screen'), startedAt,
  });
  assert.equal(newToasts(before).length, 0, 'nothing sits over the drawer');
  closeDrawer();
  const raised = newToasts(before);
  assert.equal(raised.length, 1, 'the refusal is on screen once the drawer left');
  const { title, type } = shown(raised[0]);
  assert.deepEqual([title, type], ['Could not follow Ada Lovelace. Try again.', 'error']);
  toast.dismiss();
});

// The Follows sheet closed, or the Follows page left, before Undo was refused.
test('a refusal settling after the list closed, with nothing opened since, shows at once', () => {
  const before = new Set(toast.getToasts().map(entry => entry.id));
  const closeSheet = openOverlay();
  const startedAt = actionStart({ leaving: 1 });
  closeSheet();
  sayFollowRefused({ message: 'Could not follow Nature. Try again.' }, { inView: () => false, showInLine: () => assert.fail('the line is not on screen'), startedAt });
  assert.deepEqual(newToasts(before).map(id => shown(id).title), ['Could not follow Nature. Try again.']);
  toast.dismiss();
});

// Signed out in another tab while a Follow pressed in the palette, on the
// Search page or in the Explorer was under way: its refusal settles for
// whoever reads now, in the palette still open or in a toast.
test('a refusal settling after the account changed is said neither in the line nor in a toast', (t) => {
  t.mock.method(console, 'error', () => {});
  const before = new Set(toast.getToasts().map(entry => entry.id));
  const closePalette = openOverlay();
  const inPalette = actionStart({ leaving: 1 });
  forgetAccountToasts('reader-a');
  const refused = { message: 'Could not follow Ada Lovelace. Try again.' };
  sayFollowRefused(refused, { inView: () => true, inOverlay: true, showInLine: () => assert.fail('the reader now did not press it'), startedAt: inPalette });
  closePalette();
  sayFollowRefused(refused, { inView: () => false, showInLine: () => assert.fail('the line is not on screen'), startedAt: inPalette });
  const onPage = actionStart();
  forgetAccountToasts(null);
  toastFollowRefused(new Error('PERMISSION_DENIED'), { name: 'Econometrica', following: false, startedAt: onPage });
  assert.equal(newToasts(before).length, 0, 'no toast was raised');
});

// A refused Follow's line is on screen in the palette, or on the Follows
// page, when reader A signs out, or B signs in, in another tab.
test('a refusal line said to one account is not shown once another, or nobody, is signed in', () => {
  const line = { uid: 'reader-a', refused: { message: 'Could not follow Ada Lovelace. Try again.' } };
  assert.equal(refusalShownTo(line, 'reader-a'), line.refused, 'reader A still sees it');
  assert.equal(refusalShownTo(line, 'reader-b'), null, 'reader B does not');
  assert.equal(refusalShownTo(line, undefined), null, 'nor does anyone signed out');
  assert.equal(refusalShownTo(null, undefined), null, 'no line shows nothing');
});

test('a press that went through says nothing', async () => {
  assert.equal(await toggleFollowOrRefusal({ type: 'author', id: 'A1', name: 'Ada Lovelace' }, {
    isFollowing: () => false,
    toggleFollow: () => Promise.resolve(true),
  }), null);
});
