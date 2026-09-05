/**
 * The sheet's one-line confirmations ("Comment posted.", "Changes saved.",
 * "Reported.") and its failures, as a value with a lifecycle.
 *
 * `seq` is what makes two identical confirmations two events: the chip is
 * keyed by it, so posting twice enters twice, and a timer armed for one
 * notice can never clear the next. A success leaves on its own after
 * NOTICE_SUCCESS_MS — long enough to read four words, short enough not to
 * read as stuck. Errors stay until the next action, because a failure is
 * something the reader may need to act on.
 */

export const NOTICE_SUCCESS_MS = 2400;

export const IDLE_NOTICE = Object.freeze({ tone: 'status', text: '', seq: 0 });

export function nextNotice(previous, { tone, text }) {
  return { tone, text, seq: (previous?.seq ?? 0) + 1 };
}

export function clearedNotice(previous) {
  if (!previous?.text) return previous;
  return { ...previous, text: '' };
}

export function noticeLifetime(notice) {
  if (!notice?.text) return null;
  return notice.tone === 'success' ? NOTICE_SUCCESS_MS : null;
}

export function expireNotice(previous, seq) {
  return previous?.seq === seq ? clearedNotice(previous) : previous;
}
