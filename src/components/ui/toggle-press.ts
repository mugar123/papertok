type TogglePress = {
  preventDefault(): void;
  stopPropagation(): void;
  preventBaseUIHandler(): void;
};

/**
 * The props a Toggle (toggle.ts) takes from its `pending` state. While its
 * press is saved the toggle is `aria-disabled` rather than natively disabled,
 * so it keeps focus, and it swallows the press: Base UI does not flip it, the
 * caller's handler does not run, and the click does not reach a clickable row
 * around it (a search result, a palette item), which would otherwise open
 * that row.
 */
export function pendingToggleProps<Press extends TogglePress>(pending: boolean, onClick: ((event: Press) => void) | undefined) {
  return {
    'aria-disabled': pending || undefined,
    onClick: (event: Press) => {
      if (pending) {
        event.preventDefault();
        event.stopPropagation();
        event.preventBaseUIHandler();
        return;
      }
      onClick?.(event);
    },
  };
}
