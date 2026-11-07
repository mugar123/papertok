import { pinAnalyticsContext } from '../pdf/viewer-outcome.ts';
import type { Visibility } from '../pdf/viewer-outcome.ts';

/**
 * One reading session's visible time, for `reader_time` on `stop`. A hidden
 * tab's time is left out: a reader forgotten in a background tab was not being
 * read.
 *
 * The session keeps to the consent and account it opened under, as the
 * viewer's does (viewer-outcome.ts): once either changes, `stop` sends nothing,
 * and the guard handed to `send` turns false for a send still waiting on the
 * SDK. `check` lets the reader drop the session the moment either changes.
 */
export function startReaderTime({ now, visibility, context, send }: {
  now: () => number;
  visibility: Visibility;
  context: () => string;
  send: (seconds: number, stillValid: () => boolean) => void;
}) {
  const check = pinAnalyticsContext(context);
  let visibleSince: number | null = visibility.hidden() ? null : now();
  let seconds = 0;
  let stopped = false;
  const pause = () => {
    if (visibleSince !== null) seconds += (now() - visibleSince) / 1000;
    visibleSince = null;
  };
  const unsubscribe = visibility.subscribe(() => {
    if (visibility.hidden()) pause();
    else visibleSince ??= now();
  });

  return {
    check,
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      pause();
      if (check()) send(seconds, check);
    },
  };
}
