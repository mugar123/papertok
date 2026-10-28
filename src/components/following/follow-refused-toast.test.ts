import type { Action, ToastT } from 'sonner';
import test from 'node:test';
import assert from 'node:assert/strict';
import { toast } from 'sonner';
import { toastFollowRefused } from './follow-refused-toast.ts';
import { FollowsUnavailableError, JournalFollowLimitError } from '../../utils/following.ts';

/** The toast `id` put on screen, as the Toaster would render it. */
function shown(id: string | number) {
  const item = toast.getToasts().find((entry): entry is ToastT => entry.id === id && !('dismiss' in entry && entry.dismiss));
  assert.ok(item, 'a toast was raised');
  const action = item.action && typeof item.action === 'object' && 'onClick' in item.action ? item.action : null;
  return { title: item.title, type: item.type, duration: item.duration, closeButton: item.closeButton, action };
}

// ENG-123: the Explorer's Follow is refused for a journal past the limit, or
// while the follow list is not in hand. Each toast stays until it is closed:
// Tab from the button does not reach the toast region, which comes first in
// the page, so a keyboard user needs time to get to the action.
test('a journal past the limit is refused in a toast that stays, with a way to Settings', () => {
  let opened = 0;
  const toastShown = shown(toastFollowRefused(new JournalFollowLimitError(10), {
    name: 'Econometrica', following: false, openSettings: () => { opened += 1; },
  }));
  assert.deepEqual({ ...toastShown, action: toastShown.action?.label }, {
    title: 'You already follow 10 journals, the most you can. Unfollow one in Settings to follow Econometrica.',
    type: 'error',
    duration: Infinity,
    closeButton: true,
    action: 'Open Settings',
  });
  toastShown.action!.onClick({} as Parameters<Action['onClick']>[0]);
  assert.equal(opened, 1);
  assert.equal(shown(toastFollowRefused(new JournalFollowLimitError(10), { name: 'Econometrica', following: false })).action, null, 'no way to Settings from Settings');
});

// Two devices following at once can store an eleventh journal; the toast
// counts what the reader follows, as the Journals tab's note does.
test('a reader already past the journal limit is told how many they follow and how many to unfollow', () => {
  const toastShown = shown(toastFollowRefused(new JournalFollowLimitError(11), { name: 'Econometrica', following: false, openSettings: () => {} }));
  assert.deepEqual([toastShown.title, toastShown.action?.label], [
    'You follow 11 journals, more than the 10 you can. Unfollow 2 in Settings to follow Econometrica.', 'Open Settings',
  ]);
});

test('a follow list that has not loaded refuses in a toast that stays, offering a reload only once the listener ended', () => {
  const waiting = shown(toastFollowRefused(new FollowsUnavailableError(), { name: 'Econometrica', following: false }));
  assert.deepEqual([waiting.title, waiting.duration, waiting.closeButton, waiting.action], [
    'Your follows have not loaded yet, so Econometrica was not followed. Try again in a moment.', Infinity, true, null,
  ]);
  const failed = shown(toastFollowRefused(new FollowsUnavailableError({ retryable: false }), { name: 'Econometrica', following: false }));
  assert.deepEqual([failed.title, failed.duration, failed.closeButton, failed.action?.label], [
    'Your follows could not be loaded, so Econometrica was not followed. Reload the page to try again.', Infinity, true, 'Reload',
  ]);
});

// The rules refuse a journal follow until they are deployed, and a write can
// fail for any other reason: the Follow toggle flips back, and says so.
test('any other refusal says what was not done, for a follow and for an unfollow', (t) => {
  t.mock.method(console, 'error', () => {});
  const follow = shown(toastFollowRefused(new Error('PERMISSION_DENIED'), { name: 'Econometrica', following: false }));
  assert.deepEqual([follow.title, follow.type, follow.duration, follow.closeButton], ['Could not follow Econometrica. Try again.', 'error', Infinity, true]);
  const unfollow = shown(toastFollowRefused(new Error('unavailable'), { name: 'Ada Lovelace', following: true }));
  assert.equal(unfollow.title, 'Could not unfollow Ada Lovelace. Try again.');
});
