import { useLayoutEffect, useState } from 'react';

type Focusable = Pick<HTMLElement, 'focus' | 'isConnected'>;

/**
 * The memory behind useRetryFocus, apart from React. `attach` is the button's
 * ref, `focused` runs when the button takes the focus, with the control the
 * button is for, and `settle` runs after each commit with whether the button
 * is still shown. `activeElement` says where the focus is.
 */
export function createRetryFocus(activeElement: () => unknown) {
  let button: Focusable | null = null;
  let heir: Focusable | null = null;
  let hadFocus = false;
  return {
    attach: (node: Focusable | null) => {
      // React detaches a ref while the button is still in the page, which is
      // the last moment the focus can be told from where it fell.
      if (!node) hadFocus = button !== null && activeElement() === button;
      button = node;
    },
    focused: (control: Focusable | null) => {
      heir = control;
    },
    settle: (shown: boolean) => {
      if (shown || !hadFocus) return;
      hadFocus = false;
      if (heir?.isConnected) heir.focus();
    },
  };
}

/**
 * Keeps the focus of a "Try again" button that goes away when the load it
 * retries ends. The button shows only while the load has `failed`, and a slow
 * load can still finish by itself (popup-redirect-resolver.ts): the button then
 * leaves under the reader's focus, and the focus falls to the page or to the
 * dialog around it, a place lost to a keyboard or screen-reader reader.
 *
 * `shown` is whether the button is rendered. `control` returns the element
 * that takes the focus when the button leaves while it has it: the control the
 * button is for. It is read when the button gets the focus, because the commit
 * that removes the button can already have unlinked the control from its note.
 * Spread the result on the button.
 */
export default function useRetryFocus(shown: boolean, control: () => HTMLElement | null) {
  const [memory] = useState(() => createRetryFocus(() => document.activeElement));
  useLayoutEffect(() => {
    memory.settle(shown);
  });
  return { ref: memory.attach, onFocus: () => { memory.focused(control()); } };
}
