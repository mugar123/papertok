import { useLayoutEffect, useState } from 'react';

type Focusable = Pick<HTMLElement, 'focus'>;

/**
 * What a feed hands its source's empty state for a retry button: the `ref`
 * useWaitFocus returns, and the id the state names its text with, which
 * describes the button (emptyStateDescription in empty-state.tsx).
 */
export type WaitRetry = { ref: (node: HTMLElement | null) => void; textId: string };

/**
 * The memory behind useWaitFocus, apart from React. `attach` is the ref of
 * the retry buttons, and `settle` runs after each commit with the place the
 * focus waits on while a load runs (null once nothing is loading) and the
 * place it lands when the load ends without a retry button. `activeElement`
 * says where the focus is, null when it is on the page body.
 */
export function createWaitFocus(activeElement: () => unknown) {
  let button: Focusable | null = null;
  // A retry button left under the reader's focus, and the focus has not
  // found a place since.
  let owed = false;
  let parked: Focusable | null = null;
  return {
    attach: (node: Focusable | null) => {
      // React detaches a ref while the button is still in the page, which is
      // the last moment the focus can be told from where it fell.
      if (!node && button !== null && activeElement() === button) owed = true;
      button = node;
    },
    settle: (wait: Focusable | null, landing: () => Focusable | null) => {
      if (!owed) return;
      const active = activeElement();
      if (active !== null && active !== parked) {
        // The reader moved on during the wait: their focus stays theirs.
        owed = false;
        parked = null;
        return;
      }
      if (wait) {
        if (active !== wait) wait.focus();
        parked = wait;
        return;
      }
      const heir = button ?? landing();
      // Nothing to land on yet (a commit between two states): stay owed,
      // and still only for a focus that is lost or parked.
      if (!heir) return;
      heir.focus();
      // A control that refused the focus leaves it owed for the next commit.
      if (activeElement() !== heir) return;
      owed = false;
      parked = null;
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
 * elsewhere keeps it there. Put the returned ref on every retry button.
 */
export default function useWaitFocus(wait: () => HTMLElement | null, landing: () => HTMLElement | null) {
  const [memory] = useState(() => createWaitFocus(() => {
    const active = document.activeElement;
    return active === document.body ? null : active;
  }));
  useLayoutEffect(() => {
    memory.settle(wait(), landing);
  });
  return memory.attach;
}
