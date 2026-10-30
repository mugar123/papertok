type TogglePress = {
  preventDefault(): void;
  stopPropagation(): void;
  preventBaseUIHandler(): void;
};

/**
 * The press handler of a Toggle. While its press is saved (`pending`) the
 * toggle swallows the press: Base UI does not flip it, the caller's handler
 * does not run, and the click does not reach a clickable row around it (a
 * search result, a palette item), which would otherwise open that row.
 */
export function togglePressHandler<Press extends TogglePress>(pending: boolean, onClick: ((event: Press) => void) | undefined) {
  return (event: Press) => {
    if (pending) {
      event.preventDefault();
      event.stopPropagation();
      event.preventBaseUIHandler();
      return;
    }
    onClick?.(event);
  };
}
