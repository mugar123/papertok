/** The element id of a place the article shows: a section, a figure, a reference. */
export const anchor = (id: string) => `ft-${id}`;

/**
 * Brings a place in the article into view, gives it focus and makes it shine
 * once (`[data-landed]` in full-text-article.css), restarting the shine when it
 * is landed on again.
 */
export function landOn(element: HTMLElement, block: ScrollLogicalPosition) {
  element.scrollIntoView({ block });
  element.focus({ preventScroll: true });
  element.removeAttribute('data-landed');
  void element.offsetWidth;
  element.setAttribute('data-landed', '');
}
