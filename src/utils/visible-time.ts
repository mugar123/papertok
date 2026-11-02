// Report one visible interval per viewport visit, combining foreground time
// across tab switches and covered stretches. Each instance belongs to one
// paper's effect lifetime.
export function trackVisibleTime(
  visibility: Pick<Document, 'hidden'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  report: (seconds: number) => void,
  now = () => performance.now(),
) {
  let inView = false;
  let covered = false;
  let startedAt: number | null = null;
  let elapsed = 0;

  const pause = () => {
    if (startedAt !== null) elapsed += now() - startedAt;
    startedAt = null;
  };
  const update = () => {
    if (inView && !covered && !visibility.hidden) startedAt ??= now();
    else pause();
  };
  const flush = () => {
    pause();
    const seconds = elapsed / 1000;
    elapsed = 0;
    if (seconds > 0) report(seconds);
  };

  visibility.addEventListener('visibilitychange', update);
  return {
    setInView(value: boolean) {
      inView = value;
      update();
      if (!inView) flush();
    },
    // Paused like a hidden tab while something the card does not own covers
    // it; the stretch on screen goes on when it is uncovered.
    setCovered(value: boolean) {
      covered = value;
      update();
    },
    stop() {
      visibility.removeEventListener('visibilitychange', update);
      inView = false;
      flush();
    },
  };
}
