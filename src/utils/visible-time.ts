let cardsCovered = false;
const coverListeners = new Set<(leaving: boolean) => void>();

/**
 * Whether the privacy dialog is drawn over the feed's cards. NudgeHost sets it
 * while the dialog is open, and every tracked card pauses as in a hidden tab,
 * so the seconds spent on the dialog are not reported as time on a paper: not
 * to what the feed learns from, nor as dwell in analytics. Only that dialog
 * sets it, because it opens without being asked for. The reader and the app's
 * other modals are opened by the person reading, and time under them counts
 * as it did before the dialog existed.
 *
 * `leaving` lifts the cover from cards that are going away with their page,
 * when the dialog closes because the reader left the feed rather than answered
 * it: the leaving feed stays on screen while it plays its exit, and those cards
 * stay paused until they stop, so they report nothing the reader did not see.
 * A card tracked from then on, on the next page or on the feed again, counts
 * as usual. A cover laid again over a leaving card takes it back in.
 */
export function setCardsCovered(value: boolean, { leaving = false } = {}) {
  if (value === cardsCovered) return;
  cardsCovered = value;
  for (const listener of coverListeners) listener(!value && leaving);
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
  let leaving = false;
  let startedAt: number | null = null;
  let elapsed = 0;

  const pause = () => {
    if (startedAt !== null) elapsed += now() - startedAt;
    startedAt = null;
  };
  const update = () => {
    if (inView && !cardsCovered && !leaving && !visibility.hidden) startedAt ??= now();
    else pause();
  };
  const onCover = (coverLeaving: boolean) => {
    leaving = coverLeaving;
    update();
  };
  const flush = () => {
    pause();
    const seconds = elapsed / 1000;
    elapsed = 0;
    if (seconds > 0) report(seconds);
  };

  visibility.addEventListener('visibilitychange', update);
  coverListeners.add(onCover);
  return {
    setInView(value: boolean) {
      inView = value;
      update();
      if (!inView) flush();
    },
    stop() {
      visibility.removeEventListener('visibilitychange', update);
      coverListeners.delete(onCover);
      inView = false;
      flush();
    },
  };
}
