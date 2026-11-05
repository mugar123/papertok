export const anchor = (id: string) => `ft-${id}`;

export const anchorTarget = (elementId: string) => elementId.replace(/^ft-/, '');

// Removing and re-adding `data-landed` restarts the shine on a second landing.
export function landOn(element: HTMLElement, block: ScrollLogicalPosition) {
  element.scrollIntoView({ block });
  element.focus({ preventScroll: true });
  element.removeAttribute('data-landed');
  void element.offsetWidth;
  element.setAttribute('data-landed', '');
}
