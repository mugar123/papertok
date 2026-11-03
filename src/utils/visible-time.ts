let cardsCovered = false;
const coverListeners = new Set<() => void>();

/**
 * Whether the privacy dialog is drawn over the feed's cards. NudgeHost sets it
 * while the dialog is open, and every tracked card pauses as in a hidden tab,
 * so the seconds spent on the dialog are not reported as time on a paper: not
 * to what the feed learns from, nor as dwell in analytics. Only that dialog
 * sets it, because it opens without being asked for. The reader and the app's
 * other modals are opened by the person reading, and time under them counts
 * as it did before the dialog existed.
 */
export function setCardsCovered(value: boolean) {
  if (value === cardsCovered) return;
  cardsCovered = value;
  for (const listener of coverListeners) listener();
}

// Report one visible interval per viewport visit, combining foreground time
// across tab switches and covered stretches. Each instance belongs to one
// paper's effect lifetime.
export function trackVisibleTime(
  visibility: Pick<Document, 'hidden'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  report: (seconds: number) => void,
  now = () => performance.now(),
) {
  let inView = false;
  let startedAt: number | null = null;
  let elapsed = 0;

  const pause = () => {
    if (startedAt !== null) elapsed += now() - startedAt;
    startedAt = null;
  };
  const update = () => {
    if (inView && !cardsCovered && !visibility.hidden) startedAt ??= now();
    else pause();
  };
  const flush = () => {
    pause();
    const seconds = elapsed / 1000;
    elapsed = 0;
    if (seconds > 0) report(seconds);
  };

  visibility.addEventListener('visibilitychange', update);
  coverListeners.add(update);
  return {
    setInView(value: boolean) {
      inView = value;
      update();
      if (!inView) flush();
    },
    stop() {
      visibility.removeEventListener('visibilitychange', update);
      coverListeners.delete(update);
      inView = false;
      flush();
    },
  };
}
