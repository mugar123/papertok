import { useLayoutEffect, useState } from 'react';

type Focusable = Pick<HTMLElement, 'focus'>;

/**
 * The memory behind useWaitFocus, apart from React. `attach` is the ref of
 * the retry buttons, and `settle` runs after each commit with the place the
 * focus waits on while a load runs (null once nothing is loading), the place
 * it lands when the load ends without a retry button, and whether a load
 * still runs or is due. `activeElement` says where the focus is, null when it
 * is on the page body.
 */
export function createWaitFocus(activeElement: () => unknown) {
  let button: Focusable | null = null;
  // A retry button left under the reader's focus, and the focus has not
  // found a place since.
  let owed = false;
  let parked: Focusable | null = null;
  // The load ended on a page with nowhere to land, such as Following's empty
  // state, which has no retry button.
  let endedWithoutPlace = false;
  const release = () => {
    owed = false;
    parked = null;
    endedWithoutPlace = false;
  };
  return {
    attach: (node: Focusable | null) => {
      // React detaches a ref while the button is still in the page, which is
      // the last moment the focus can be told from where it fell.
      if (!node && button !== null && activeElement() === button) {
        owed = true;
        endedWithoutPlace = false;
      }
      button = node;
    },
    settle: (wait: Focusable | null, landing: () => Focusable | null, loading: boolean) => {
      if (!owed) return;
      const active = activeElement();
      if (active !== null && active !== parked) {
        // The reader moved on during the wait: their focus stays theirs.
        release();
        return;
      }
      if (wait) {
        // A wait after the retry's load ended was started by another
        // control, such as Check for updates: the focus stays where it fell.
        if (endedWithoutPlace) {
          release();
          return;
        }
        if (active !== wait) wait.focus();
        parked = wait;
        return;
      }
      const heir = button ?? landing();
      if (!heir) {
        // Nothing to land on yet: stay owed, and still only for a focus that
        // is lost or parked. Following shows the papers of a finished load
        // one commit after its empty state, so the place may still come.
        if (!loading) endedWithoutPlace = true;
        return;
      }
      heir.focus();
      // A control that refused the focus leaves it owed for the next commit.
      if (activeElement() !== heir) return;
      release();
    },
  };
}

/**
 * Keeps the place of a reader who pressed a feed's retry button. The button
 * leaves as the reload starts, so the focus would fall to the page for the
 * whole wait, and stay there when the error or the papers come back.
 *
 * useRetryFocus does not fit here: its heir is read when the button takes the
 * focus and must already be in the page, while the feed's wait has nothing
 * that outlives the button. Here the focus waits on `wait()`, the wait's
 * heading, while it is shown, then goes to the retry button that came back,
 * or to `landing()` when the papers did. A reader who moved the focus
 * elsewhere keeps it there. `loading` says whether a load still runs or is
 * due. Put the returned ref on every retry button.
 */
export default function useWaitFocus(wait: () => HTMLElement | null, landing: () => HTMLElement | null, loading: boolean) {
  const [memory] = useState(() => createWaitFocus(() => {
    const active = document.activeElement;
    return active === document.body ? null : active;
  }));
  useLayoutEffect(() => {
    memory.settle(wait(), landing, loading);
  });
  return memory.attach;
}
