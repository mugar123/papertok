/**
 * What a request to close the save modal does. Base UI reports every
 * dismissal (Escape, a press on the scrim, the X) with its `reason`, and
 * none of them closes the window directly.
 *
 * Nothing closes while a save runs. With unsaved changes the request asks
 * to discard them first. Once that question is on screen, pressing the X
 * again (`close-press`) is its answer and closes, as Discard would; Escape
 * and the scrim keep asking, so a stray press cannot cost somebody their note.
 */
export function saveModalCloseRequest({ reason, saving, open, dirty, confirmingDiscard }: {
  reason: string;
  saving: boolean;
  open: boolean;
  dirty: boolean;
  confirmingDiscard: boolean;
}): 'ignore' | 'confirmDiscard' | 'close' {
  if (saving || !open) return 'ignore';
  const explicit = reason === 'close-press';
  if (dirty && !(explicit && confirmingDiscard)) return 'confirmDiscard';
  return 'close';
}
